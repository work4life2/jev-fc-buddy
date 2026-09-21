import { getConfig } from "../config.js";
import { logger } from "../log.js";
import type { GameProfile } from "../games/registry.js";
import { Coach } from "./coach.js";
import { jevDecide, jevEnabled, type JevAction, type JevDecision } from "./jev.js";
import { observe, type Observation } from "./observe.js";
import { actionFor, heuristicIntent, IDLE, newMemory, sameAction, type Action, type Button, type Intent, type PolicyMemory } from "./policy.js";

const log = logger("buddy");

/** Messages the brain sends to the browser. */
export type OpSource = "reflex" | "jev" | "coach" | "macro" | "system";

export type BuddyMessage =
  | { type: "act"; controller: number; hold: Button[]; turbo: Button[]; tag: string; src: string }
  | { type: "op"; src: OpSource; text: string; detail?: Record<string, unknown>; at: number }
  | { type: "say"; text: string; at: number }
  | { type: "needShot" }
  | { type: "status"; jev: boolean; coach: string; phase: string };

export interface BrainOptions {
  game: GameProfile;
  lang: string;
  send: (m: BuddyMessage) => void;
}

/**
 * One brain per play session. Three layers:
 *   reflex (every tick, code)  →  Jev (typed decision, a few Hz)  →  coach (pi/LLM, every ~10 s)
 * Every decision that changes the controller is echoed to the ops stream (the danmaku).
 */
export class BuddyBrain {
  private readonly game: GameProfile;
  private readonly send: (m: BuddyMessage) => void;
  private readonly coach: Coach;
  private mem: PolicyMemory = newMemory();
  private last: Action = IDLE;
  private lastObs: Observation | undefined;
  private jev: { decision: JevDecision; at: number } | undefined;
  private jevInflight = false;
  private jevLastAt = 0;
  private coachIntent: JevAction | "auto" = "auto";
  private coachPlan = "";
  private coachTimer: NodeJS.Timeout | undefined;
  private pendingShot: string | undefined;
  private recent: string[] = [];
  private macroCooldownUntil = 0;
  private stopped = false;
  private stats = { ticks: 0, jevCalls: 0, coachRounds: 0, aiDeaths: 0, humanDeaths: 0, actions: new Map<string, number>() };
  private lastPhase = "";

  constructor(o: BrainOptions) {
    this.game = o.game;
    this.send = o.send;
    this.coach = new Coach(o.game, o.lang);
    const { ai } = getConfig();
    this.coachTimer = setInterval(() => void this.coachRound(), ai.coachIntervalSeconds * 1000);
    this.send({ type: "status", jev: jevEnabled(), coach: this.coach.model, phase: "boot" });
    this.op("system", jevEnabled() ? `Jev online (${getConfig().typesafe.model}${getConfig().typesafe.viaRelay ? " via relay" : ""}) · coach ${this.coach.model}` : `Jev offline (no relay/TypeSafe key) · reflex + coach ${this.coach.model}`);
  }

  private op(src: OpSource, text: string, detail?: Record<string, unknown>) {
    this.send({ type: "op", src, text, detail, at: Date.now() });
  }

  private remember(line: string) {
    this.recent.push(line);
    if (this.recent.length > 12) this.recent.shift();
  }

  onScreenshot(jpegBase64: string) {
    this.pendingShot = jpegBase64;
  }

  /** Called for every state report from the browser. */
  onObservation(bytes: Uint8Array) {
    if (this.stopped) return;
    const obs = observe(this.game, bytes);
    const prev = this.lastObs;
    this.lastObs = obs;
    this.stats.ticks++;
    const now = obs.at;

    if (obs.phase !== this.lastPhase) {
      this.lastPhase = obs.phase;
      this.send({ type: "status", jev: jevEnabled(), coach: this.coach.model, phase: obs.phase });
      this.remember(`phase → ${obs.phase}`);
      if (obs.phase === "playing") this.op("system", `level ${obs.level + 1} · go!`);
      if (obs.phase === "gameover") this.op("system", "game over");
    }
    if (prev && obs.phase === "playing") {
      if (prev.ai.alive && !obs.ai.alive) {
        this.stats.aiDeaths++;
        this.remember("buddy died");
        this.op("system", `buddy down (lives ${obs.ai.lives})`);
      }
      if (prev.human.alive && !obs.human.alive) {
        this.stats.humanDeaths++;
        this.remember("partner died");
      }
      if (prev.level !== obs.level) this.remember(`level ${obs.level + 1}`);
    }

    switch (obs.phase) {
      case "title":
        this.titleMacro(obs, now);
        return;
      case "playing":
        if (!obs.ai.alive) {
          this.apply(IDLE, "reflex");
          return;
        }
        this.play(obs, now);
        return;
      default:
        this.apply(IDLE, "reflex");
    }
  }

  /** Title screen: select 2 players, then start. */
  private titleMacro(obs: Observation, now: number) {
    if (now < this.macroCooldownUntil) return;
    const want = this.game.start.requirePlayerMode ?? 1;
    if (obs.playerMode !== want) {
      this.tap(this.game.start.selectButton as Button, "macro", `SELECT → ${want + 1} players`);
      this.macroCooldownUntil = now + 600;
    } else {
      this.tap(this.game.start.startButton as Button, "macro", "START");
      this.macroCooldownUntil = now + 2500;
    }
  }

  private tap(button: Button, src: "macro", text: string) {
    this.send({ type: "act", controller: this.game.players.ai, hold: [button], turbo: [], tag: text, src });
    this.op(src, text);
    setTimeout(() => this.send({ type: "act", controller: this.game.players.ai, hold: [], turbo: [], tag: "release", src }), 120);
    this.last = IDLE;
  }

  private play(obs: Observation, now: number) {
    const { ai } = getConfig();
    // 1. Ask Jev at most jevHz times a second, one request in flight.
    if (jevEnabled() && !this.jevInflight && now - this.jevLastAt >= 1000 / ai.jevHz) {
      this.jevInflight = true;
      this.jevLastAt = now;
      this.stats.jevCalls++;
      void jevDecide(obs, { coachIntent: this.coachIntent === "auto" ? this.coachPlan || undefined : `${this.coachIntent}: ${this.coachPlan}`, recent: this.recent.slice(-5) })
        .then((d) => {
          if (!d || this.stopped) return;
          const changed = !this.jev || this.jev.decision.action !== d.action;
          this.jev = { decision: d, at: Date.now() };
          if (changed) {
            const top = Object.entries(d.probabilities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
              .join(" · ");
            this.op("jev", `${d.action} (conf ${(d.confidence * 100).toFixed(0)}%, ${d.latencyMs}ms)`, { top, partnerInDanger: d.partnerInDanger, jumpNow: d.jumpNow });
          }
        })
        .finally(() => (this.jevInflight = false));
    }

    // 2. Pick the intent: fresh + confident Jev answer wins, else coach, else heuristics.
    let intent: Intent;
    let src: "jev" | "coach" | "reflex" = "reflex";
    let why = "";
    const fresh = this.jev && now - this.jev.at < 1500 ? this.jev.decision : undefined;
    if (fresh && fresh.jumpNow > 0.7 && obs.ai.onGround && now - this.mem.lastJumpAt > 800) {
      intent = "jump_forward";
      src = "jev";
      why = `dodge (jump_now ${(fresh.jumpNow * 100).toFixed(0)}%)`;
    } else if (fresh && fresh.confidence >= 0.3) {
      intent = fresh.action;
      src = "jev";
    } else if (this.coachIntent !== "auto") {
      intent = this.coachIntent;
      src = "coach";
    } else {
      const h = heuristicIntent(this.game, obs, this.mem, now);
      intent = h.intent;
      why = h.why;
    }
    // Safety net regardless of source: an enemy directly above still gets shot.
    const h = heuristicIntent(this.game, obs, this.mem, now);
    if (h.intent === "aim_up_fire" && intent !== "aim_up_fire") {
      intent = "aim_up_fire";
      src = "reflex";
      why = h.why;
    }
    const action = actionFor(this.game, obs, intent, this.mem, now);
    action.reason = why || action.reason;
    this.apply(action, src);
  }

  private apply(action: Action, src: "jev" | "coach" | "reflex") {
    if (sameAction(action, this.last)) return;
    this.last = action;
    this.send({ type: "act", controller: this.game.players.ai, hold: action.hold, turbo: action.turbo, tag: action.tag, src });
    if (action !== IDLE) {
      const keys = [...action.hold, ...action.turbo.map((b) => `${b}*`)].join(" + ");
      this.op(src, `${keys}  ${action.reason}`.trim());
      this.stats.actions.set(action.tag, (this.stats.actions.get(action.tag) ?? 0) + 1);
    }
  }

  private summary(): string {
    const acts = [...this.stats.actions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    const lines = [
      `Since the last round: ${this.recent.length ? this.recent.join("; ") : "nothing notable"}.`,
      `Buddy inputs used: ${acts || "none"}. Jev calls: ${this.stats.jevCalls}. Buddy deaths so far: ${this.stats.aiDeaths}, partner deaths: ${this.stats.humanDeaths}.`,
      this.coachPlan ? `Your previous plan: ${this.coachPlan}` : "",
    ];
    this.recent = [];
    this.stats.actions.clear();
    return lines.filter(Boolean).join("\n");
  }

  private async coachRound() {
    if (this.stopped || !this.lastObs) return;
    if (this.lastObs.phase !== "playing" && this.lastObs.phase !== "gameover") return;
    if (this.coach.supportsVision) {
      this.send({ type: "needShot" });
      await new Promise((r) => setTimeout(r, 400));
    }
    const shot = this.pendingShot;
    this.pendingShot = undefined;
    this.stats.coachRounds++;
    const advice = await this.coach.advise(this.summary(), this.lastObs, shot);
    if (!advice || this.stopped) return;
    this.coachIntent = advice.intent;
    this.coachPlan = advice.plan;
    this.op("coach", `${advice.intent}${advice.plan ? ` — ${advice.plan}` : ""} (${advice.latencyMs}ms)`);
    if (advice.say) this.send({ type: "say", text: advice.say, at: Date.now() });
    // A coach intent is a bias for a while, not forever.
    setTimeout(() => {
      if (this.coachIntent === advice.intent) this.coachIntent = "auto";
    }, getConfig().ai.coachIntervalSeconds * 1000);
  }

  stop() {
    this.stopped = true;
    if (this.coachTimer) clearInterval(this.coachTimer);
    this.coach.dispose();
    log.info(`brain stopped: ticks=${this.stats.ticks} jev=${this.stats.jevCalls} coach=${this.stats.coachRounds} deaths=${this.stats.aiDeaths}/${this.stats.humanDeaths}`);
  }
}
