import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { genreOf, type GameProfile } from "../games/registry.js";
import { dangersNear, jevDecide, jevEnabled, type JevAction, type JevDecision } from "./jev.js";
import { actionCriteria } from "./criteria.js";
import { observe, type Observation } from "./observe.js";
import { actionFor, edgeAhead, gapAhead, heuristicIntent, IDLE, newMemory, respawnSteer, sameAction, survivalIntent, type Action, type Button, type Intent, type PolicyMemory } from "./policy.js";
import { newTankMemory, TANK_INTENTS, tankDecide, type TankIntent, type TankMemory } from "./tankPolicy.js";

const log = logger("buddy");

/** Messages the brain sends to the browser. */
export type OpSource = "reflex" | "jev" | "macro" | "system";

export type BuddyMessage =
  | { type: "act"; controller: number; hold: Button[]; turbo: Button[]; tag: string; src: string }
  | { type: "op"; src: OpSource; text: string; detail?: Record<string, unknown>; at: number }
  | { type: "status"; jev: boolean; phase: string };

export interface BrainOptions {
  game: GameProfile;
  send: (m: BuddyMessage) => void;
  /** Ask Jev (default: whenever a key is configured). The self-play harness turns it off for fast runs. */
  jev?: boolean;
  /** Do not write deaths to the log file (self-play). */
  quiet?: boolean;
}

/**
 * One brain per play session. Two layers:
 *   reflex (every tick, code)  →  Jev (typed decision, a few Hz)
 * Every decision that changes the controller is echoed to the ops stream (the browser's pad / log view).
 */
export class BuddyBrain {
  private readonly game: GameProfile;
  private readonly send: (m: BuddyMessage) => void;
  private mem: PolicyMemory = newMemory();
  private tankMem: TankMemory = newTankMemory();
  private readonly tank: boolean;
  private last: Action = IDLE;
  private lastObs: Observation | undefined;
  private jev: { decision: JevDecision; at: number; askedAt: number } | undefined;
  private jevInflight = 0;
  private jevLastAt = 0;
  private recent: string[] = [];
  private macroCooldownUntil = 0;
  private stopped = false;
  private stats = { ticks: 0, jevCalls: 0, jevIn: 0, jevOut: 0, aiDeaths: 0, humanDeaths: 0, actions: new Map<string, number>() };
  private readonly startedAt = Date.now();
  private lastObsAt = 0;
  private playMs = 0;
  private lastPhase = "";
  private readonly useJev: boolean;
  private readonly quiet: boolean;

  constructor(o: BrainOptions) {
    this.game = o.game;
    this.tank = genreOf(o.game) === "tank";
    this.send = o.send;
    this.useJev = (o.jev ?? true) && jevEnabled();
    this.quiet = o.quiet ?? false;
    this.send({ type: "status", jev: this.useJev, phase: "boot" });
    this.op("system", this.useJev ? `Jev online (${getConfig().typesafe.model}${getConfig().typesafe.viaRelay ? " via relay" : ""})` : "Jev offline (no relay/TypeSafe key): reflex policy only");
  }

  private op(src: OpSource, text: string, detail?: Record<string, unknown>) {
    this.send({ type: "op", src, text, detail, at: Date.now() });
  }

  private remember(line: string) {
    this.recent.push(line);
    if (this.recent.length > 12) this.recent.shift();
  }

  /** Called for every state report from the browser. */
  onObservation(bytes: Uint8Array) {
    if (this.stopped) return;
    const prev = this.lastObs;
    const obs = observe(this.game, bytes, prev);
    this.lastObs = obs;
    this.stats.ticks++;
    const now = obs.at;
    // Time actually spent connected: gaps longer than 5 s (tab closed, network) are not play time.
    if (this.lastObsAt && now - this.lastObsAt < 5000) this.playMs += now - this.lastObsAt;
    this.lastObsAt = now;

    if (obs.phase !== this.lastPhase) {
      this.lastPhase = obs.phase;
      this.send({ type: "status", jev: this.useJev, phase: obs.phase });
      this.remember(`phase → ${obs.phase}`);
      if (obs.phase === "playing") this.op("system", `level ${obs.level + 1} · go!`);
      if (obs.phase === "gameover") this.op("system", "game over");
    }
    if (prev && obs.phase === "playing") {
      if (prev.ai.alive && !obs.ai.alive) {
        this.stats.aiDeaths++;
        const near = prev.enemies
          .map((e) => ({ k: e.category, t: e.type, dx: e.x - prev.ai.x, dy: e.y - prev.ai.y, vx: e.vx }))
          .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)))
          .slice(0, 3)
          .map((e) => `${e.k}#${e.t.toString(16)}(dx ${e.dx}, dy ${e.dy}, vx ${e.vx})`)
          .join(" ");
        const cause = this.tank
          ? `doing ${this.last.tag}${this.last.reason ? ` [${this.last.reason}]` : ""}; nearby: ${near || "nothing"}; at (${prev.ai.x},${prev.ai.y}) facing ${["up", "left", "down", "right"][this.tankMem.facing]} (partner at ${prev.human.x},${prev.human.y}) stage=${prev.level}`
          : `doing ${this.last.tag}${this.last.reason ? ` [${this.last.reason}]` : ""}; nearby: ${near || "nothing"}; ground=${prev.ai.onGround}; at levelX=${prev.ai.levelX} y=${prev.ai.y} (partner levelX=${prev.human.levelX} y=${prev.human.y}) level=${prev.level}`;
        this.remember(`buddy died — ${cause}`);
        this.op("system", `buddy down (lives ${obs.ai.lives}) — ${cause}`);
        if (!this.quiet) log.info(`death: ${cause}`);
      }
      if (prev.human.alive && !obs.human.alive) {
        this.stats.humanDeaths++;
        this.remember("partner died");
        this.op("system", `partner down (lives ${obs.human.lives})`);
      }
      if (prev.level !== obs.level) this.remember(`level ${obs.level + 1}`);
    }

    if (prev && obs.phase === "playing" && this.tank && prev.human.gameOver === false && obs.human.gameOver) {
      this.remember("the base was destroyed");
      this.op("system", "the base is gone — game over");
    }

    switch (obs.phase) {
      case "title":
        this.titleMacro(obs, now);
        return;
      case "loading":
        // Some games wait for START once more on a stage-select / curtain screen.
        if (this.game.start.loadingStart && now >= this.macroCooldownUntil) {
          this.tap(this.game.start.startButton as Button, "macro", "START (stage screen)");
          this.macroCooldownUntil = now + 1500;
        }
        return;
      case "playing":
        if (this.tank) {
          this.playTank(obs, now);
          return;
        }
        if (!obs.ai.alive) {
          const steer = respawnSteer(this.game, obs, this.mem);
          if (steer) this.apply({ hold: [steer.dir], turbo: [], tag: `${steer.dir}`, reason: steer.why }, "reflex");
          else this.apply(IDLE, "reflex");
          return;
        }
        this.play(obs, now);
        return;
      default:
        this.apply(IDLE, "reflex");
    }
  }

  /** Tank genre: reflexes decide the buttons; Jev only chooses the intent. */
  private playTank(obs: Observation, now: number) {
    const { ai } = getConfig();
    if (obs.ai.alive && this.useJev && this.jevInflight < 2 && now - this.jevLastAt >= 1000 / ai.jevHz) {
      this.jevInflight++;
      this.jevLastAt = now;
      this.stats.jevCalls++;
      const askedAt = now;
      void jevDecide(this.game, obs, { recent: this.recent.slice(-5) })
        .then((d) => {
          if (!d || this.stopped) return;
          this.stats.jevIn += d.usage.input;
          this.stats.jevOut += d.usage.output;
          if (this.jev && this.jev.askedAt > askedAt) return;
          const changed = !this.jev || this.jev.decision.action !== d.action;
          this.jev = { decision: d, at: Date.now(), askedAt };
          if (changed) {
            const top = Object.entries(d.probabilities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
              .join(" · ");
            this.op("jev", `${d.action} (conf ${(d.confidence * 100).toFixed(0)}%, ${d.latencyMs}ms)`, { top, partnerInDanger: d.partnerInDanger, baseInDanger: d.baseInDanger });
          }
        })
        .finally(() => this.jevInflight--);
    }
    // Intent: a fresh, reasonably confident Jev answer; else the policy's own judgement.
    let intent: TankIntent | "auto" = "auto";
    let src: "jev" | "reflex" = "reflex";
    const fresh = this.jev && now - this.jev.at < 1500 ? this.jev.decision : undefined;
    if (fresh && fresh.baseInDanger > 0.7) {
      intent = "defend_base";
      src = "jev";
    } else if (fresh && fresh.partnerInDanger > 0.75 && obs.human.alive) {
      intent = "support_partner";
      src = "jev";
    } else if (fresh && fresh.action in TANK_INTENTS && (fresh.probabilities[fresh.action] ?? 0) >= 0.3) {
      intent = fresh.action as TankIntent;
      src = "jev";
    }
    const action = tankDecide(this.game, obs, this.tankMem, now, intent);
    if (intent !== "auto" && !action.urgent) action.reason = `${action.reason} [${intent}]`;
    this.apply(action, action.urgent ? "reflex" : src);
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

  /** Menu taps go to `start.controller` when the game only listens to one controller there (Battle City: controller 1). */
  private tap(button: Button, src: "macro", text: string) {
    const controller = this.game.start.controller ?? this.game.players.ai;
    this.send({ type: "act", controller, hold: [button], turbo: [], tag: text, src });
    this.op(src, text);
    setTimeout(() => this.send({ type: "act", controller, hold: [], turbo: [], tag: "release", src }), 120);
    this.last = IDLE;
  }

  private play(obs: Observation, now: number) {
    const { ai } = getConfig();
    // 1. Ask Jev jevHz times a second with up to two requests in flight (answers ~300–700 ms apart).
    const sign: 1 | -1 = 1;
    const gap = gapAhead(this.game, obs, this.mem, sign);
    if (this.useJev && this.jevInflight < 2 && now - this.jevLastAt >= 1000 / ai.jevHz) {
      this.jevInflight++;
      this.jevLastAt = now;
      this.stats.jevCalls++;
      const askedAt = now;
      void jevDecide(this.game, obs, { recent: this.recent.slice(-5), gap, edge: edgeAhead(this.game, obs, sign), dangers: dangersNear(this.game, obs), criteria: actionCriteria(this.game, obs, this.mem) })
        .then((d) => {
          if (!d || this.stopped) return;
          this.stats.jevIn += d.usage.input;
          this.stats.jevOut += d.usage.output;
          if (this.jev && this.jev.askedAt > askedAt) return; // an answer to a newer state already arrived
          const changed = !this.jev || this.jev.decision.action !== d.action;
          this.jev = { decision: d, at: Date.now(), askedAt };
          if (changed) {
            const top = Object.entries(d.probabilities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
              .join(" · ");
            this.op("jev", `${d.action} (conf ${(d.confidence * 100).toFixed(0)}%, ${d.latencyMs}ms)`, { top, partnerInDanger: d.partnerInDanger, jumpNow: d.jumpNow });
          }
        })
        .finally(() => this.jevInflight--);
    }

    // 2. Pick the intent. Survival reflexes always win (a model round trip is too slow for a bullet);
    //    then a fresh, confident Jev answer; then the built-in heuristics.
    let intent: Intent;
    let src: "jev" | "reflex" = "reflex";
    let why = "";
    const fresh = this.jev && now - this.jev.at < 1200 ? this.jev.decision : undefined;
    const urgent = survivalIntent(this.game, obs, this.mem, now);
    if (urgent) {
      intent = urgent.intent;
      why = urgent.why;
    } else if (fresh && fresh.sprintNow > 0.65) {
      intent = "advance_fire";
      src = "jev";
      why = `sprint_now ${(fresh.sprintNow * 100).toFixed(0)}%`;
    } else if (fresh && fresh.proneNow > 0.7 && obs.ai.onGround) {
      intent = "prone_fire";
      src = "jev";
      why = `prone_now ${(fresh.proneNow * 100).toFixed(0)}%`;
    } else if (fresh && fresh.jumpNow > 0.7 && obs.ai.onGround && now - this.mem.lastJumpAt > 800) {
      intent = "jump_forward";
      src = "jev";
      why = `jump_now ${(fresh.jumpNow * 100).toFixed(0)}%`;
    } else if (fresh && fresh.partnerInDanger > 0.75 && obs.human.alive && Math.abs(obs.human.x - obs.ai.x) > this.game.reflex.closeDistance) {
      intent = "follow_partner";
      src = "jev";
      why = `partner in danger ${(fresh.partnerInDanger * 100).toFixed(0)}%`;
    } else if (fresh && this.jevPick(fresh)) {
      intent = this.jevPick(fresh)! as Intent;
      src = "jev";
    } else {
      const h = heuristicIntent(this.game, obs, this.mem, now);
      intent = h.intent;
      why = h.why;
    }
    // A jump press is held for a few frames so the emulator registers it even across a tick boundary.
    if (intent === "jump_forward" || intent === "jump_back" || intent === "jump_up") this.jumpHold = { intent, until: now + 120 };
    else if (this.jumpHold && now < this.jumpHold.until) intent = this.jumpHold.intent;
    // A prone dodge is held a little after the trigger disappears so the bullet actually passes.
    if (intent !== "prone_fire" && this.mem.proneSince) {
      if (now - this.mem.proneSince < 300 && !urgent) intent = "prone_fire";
      else this.mem.proneSince = 0;
    }
    const action = actionFor(this.game, obs, intent, this.mem, now);
    action.reason = why || action.reason;
    this.apply(action, src);
  }

  private jevSticky: { action: JevAction; since: number } | undefined;
  private jumpHold: { intent: "jump_forward" | "jump_back" | "jump_up"; until: number } | undefined;

  /**
   * Jev's distribution is often flat (top option 20–40%). Twitchy one-off actions (jumps, prone)
   * need a clear majority; steady ones (advance / follow / hold / aim) are accepted at a lower bar,
   * and the previous pick is kept unless the new one beats it by a margin (hysteresis).
   */
  private jevPick(d: JevDecision): JevAction | undefined {
    const p = d.probabilities;
    const twitchy = new Set<JevAction>(["jump_forward", "jump_back", "prone_fire", "retreat"]);
    const prev = this.jevSticky;
    const prevP = prev ? (p[prev.action] ?? 0) : 0;
    const bestP = p[d.action] ?? 0;
    let pick: JevAction | undefined;
    if (prev && Date.now() - prev.since < 2000 && prevP >= 0.18 && bestP - prevP < 0.1) pick = prev.action;
    else if (bestP >= (twitchy.has(d.action) ? 0.4 : 0.25)) pick = d.action;
    else if (prev && prevP >= 0.18) pick = prev.action;
    if (pick && pick !== prev?.action) this.jevSticky = { action: pick, since: Date.now() };
    return pick;
  }

  private apply(action: Action, src: "jev" | "reflex") {
    if (sameAction(action, this.last)) return;
    this.last = action;
    this.send({ type: "act", controller: this.game.players.ai, hold: action.hold, turbo: action.turbo, tag: action.tag, src });
    if (action !== IDLE) {
      const keys = [...action.hold, ...action.turbo.map((b) => `${b}*`)].join(" + ");
      this.op(src, `${keys}  ${action.reason}`.trim());
      this.stats.actions.set(action.tag, (this.stats.actions.get(action.tag) ?? 0) + 1);
    }
  }


  /** What this brain has consumed so far (folded into the coin window when it stops). */
  usage(): { playSeconds: number; jevCalls: number; inputTokens: number; outputTokens: number } {
    return { playSeconds: Math.round(this.playMs / 1000), jevCalls: this.stats.jevCalls, inputTokens: this.stats.jevIn, outputTokens: this.stats.jevOut };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.quiet) log.info(`brain stopped: ticks=${this.stats.ticks} play=${Math.round(this.playMs / 1000)}s jev=${this.stats.jevCalls} tokens=${this.stats.jevIn}/${this.stats.jevOut} deaths=${this.stats.aiDeaths}/${this.stats.humanDeaths} (${Math.round((Date.now() - this.startedAt) / 1000)}s)`);
  }
}
