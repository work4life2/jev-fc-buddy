import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { genreOf, type GameProfile } from "../games/registry.js";
import { jevDecide, jevEnabled, stageBrief, type JevDecision } from "./jev.js";
import { GameController, PLAN_MAX_AGE_MS } from "./control.js";
import type { PlanSelection } from "./tactics.js";
import type { Forecast } from "./rollout.js";
import { saveDecisionTrace } from "./trace.js";
import { observe, type Observation } from "./observe.js";
import { IDLE, sameAction, type Action, type Button } from "./policy.js";
import { newTankMemory, TANK_INTENTS, tankDecide, type TankIntent, type TankMemory } from "./tankPolicy.js";

const log = logger("buddy");

/** Messages the brain sends to the browser. */
export type OpSource = "reflex" | "jev" | "macro" | "system";

export type BuddyMessage =
  | { type: "act"; controller: number; hold: Button[]; turbo: Button[]; tag: string; src: string }
  | { type: "op"; src: OpSource; text: string; detail?: Record<string, unknown>; at: number }
  | { type: "status"; jev: boolean; phase: string }
  | { type: "plan"; selection: PlanSelection };

export interface BrainOptions {
  game: GameProfile;
  send: (m: BuddyMessage) => void;
  /** Ask Jev (default: whenever a key is configured). The self-play harness turns it off for fast runs. */
  jev?: boolean;
  /** Do not write deaths to the log file (self-play). */
  quiet?: boolean;
  decide?: typeof jevDecide;
}

/**
 * One brain per play session. Two layers:
 *   reflex (every tick, code)  →  Jev (typed decision, a few Hz)
 * Every decision that changes the controller is echoed to the ops stream (the browser's pad / log view).
 */
export class BuddyBrain {
  private readonly game: GameProfile;
  private readonly send: (m: BuddyMessage) => void;
  private readonly control: GameController;
  private readonly decide: typeof jevDecide;
  private observationFrame = 0;
  private clientEpoch?: number;
  private forecast?: { frame: number; level: number; lives: number; rows: Forecast[] };
  private modelStats = { responses: 0, failed: 0, rejected: 0, accepted: 0, jevTicks: 0, reflexTicks: 0, interruptions: 0, latencies: [] as number[], model: "" };
  private decisionTrace: Record<string, unknown>[] = [];
  private clientExecution?: { jevTicks: number; reflexTicks: number; rejectedPlans: number };
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
    this.control = new GameController(o.game);
    this.decide = o.decide ?? jevDecide;
    this.tank = genreOf(o.game) === "tank";
    this.send = o.send;
    this.useJev = (o.jev ?? true) && (!!o.decide || jevEnabled());
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
  onObservation(bytes: Uint8Array, frame?: number, epoch?: number) {
    if (this.stopped) return;
    const prev = this.lastObs;
    const obs = observe(this.game, bytes, prev);
    this.clientEpoch = epoch;
    this.lastObs = obs;
    this.observationFrame = frame ?? this.observationFrame + (prev ? Math.max(1, (obs.frame - prev.frame + 256) % 256) : 0);
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
    if (prev && (prev.phase !== obs.phase || prev.level !== obs.level || prev.ai.alive !== obs.ai.alive || prev.ai.lives !== obs.ai.lives)) this.jev = undefined;
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

    if (!this.tank && obs.phase !== "playing") this.control.step(obs, now);
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
      void this.decide(this.game, obs, { recent: this.recent.slice(-5) })
        .then((d) => {
          if (!d || this.stopped || !this.lastObs?.ai.alive || this.lastObs.level !== obs.level || this.lastObs.ai.lives !== obs.ai.lives || Date.now() - askedAt >= 1500) return;
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
    const fresh = this.jev && now - this.jev.askedAt < 1500 ? this.jev.decision : undefined;
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
    const step = this.control.step(obs, now);
    this.modelStats[step.source === "jev" ? "jevTicks" : "reflexTicks"]++;
    if (step.interrupted) this.modelStats.interruptions++;
    this.apply(step.action, step.source);
    const candidates = this.control.candidates;
    // A tactical choice is only useful when there is a real alternative.
    if (!this.useJev || !obs.ai.alive || candidates.length < 2 || this.jevInflight || now - this.jevLastAt < Math.max(600, 1000 / getConfig().ai.jevHz)) return;
    const epoch = this.control.epoch;
    const clientEpoch = this.clientEpoch;
    const askedAt = now;
    const frame = this.observationFrame;
    this.jevInflight++;
    this.jevLastAt = now;
    this.stats.jevCalls++;
    const forecasts = this.forecast && frame >= this.forecast.frame && frame - this.forecast.frame <= 60 && this.forecast.level === obs.level && this.forecast.lives === obs.ai.lives ? this.forecast.rows.filter(r => candidates.some(c => c.id === r.id)) : [];
    void this.decide(this.game, obs, { recent: this.recent.slice(-3), candidates, forecasts, stage: stageBrief(this.game, obs) })
      .then(d => {
        if (!d) { this.modelStats.failed++; return; }
        this.stats.jevIn += d.usage.input;
        this.stats.jevOut += d.usage.output;
        this.modelStats.responses++;
        this.modelStats.latencies.push(d.latencyMs);
        this.modelStats.model = d.model;
        const tactic = candidates.find(c => c.id === d.planId);
        const ttlMs = PLAN_MAX_AGE_MS - (Date.now() - askedAt);
        const probability = d.probabilities[d.planId ?? ""] ?? 0;
        const selection: PlanSelection | undefined = tactic ? { tactic, frame, ttlMs, probability } : undefined;
        const accepted = !this.stopped && this.control.epoch === epoch && !!selection && !!this.lastObs && this.control.accept(selection, this.lastObs, this.observationFrame, Date.now());
        this.decisionTrace.push({ frame, epoch, options: candidates.map(c => ({ id: c.id, goal: c.description })), forecasts, chosen: d.planId, probabilities: d.probabilities, latencyMs: d.latencyMs, ageMs: Date.now() - askedAt, accepted });
        if (this.decisionTrace.length > 200) this.decisionTrace.shift();
        this.modelStats[accepted ? "accepted" : "rejected"]++;
        if (this.stopped) return;
        this.op("jev", `${accepted ? "Plan" : "Discarded plan"}: ${tactic?.description ?? "unknown choice"}`, { selected: d.planId, probabilities: d.probabilities, latencyMs: d.latencyMs, ageMs: Date.now() - askedAt, accepted, model: d.model });
        if (accepted && selection) this.send({ type: "plan", selection: { ...selection, epoch: clientEpoch } });
      })
      .catch(err => { this.modelStats.failed++; if (!this.quiet) log.warn(`planner failed: ${String(err)}`); })
      .finally(() => this.jevInflight--);
  }

  diagnostics() { return { ...this.modelStats, latencies: [...this.modelStats.latencies], clientExecution: this.clientExecution, trace: [...this.decisionTrace] }; }

  async settled() {
    while (this.jevInflight > 0) await new Promise(resolve => setTimeout(resolve, 10));
  }

  onExecutionReport(value: unknown) {
    const v = value as typeof this.clientExecution;
    if (v && [v.jevTicks, v.reflexTicks, v.rejectedPlans].every(n => Number.isSafeInteger(n) && n >= 0 && n < 1_000_000)) this.clientExecution = v;
  }

  /** Public observations only; reject oversized or malformed client forecasts. */
  onForecast(value: unknown) {
    const v = value as { frame?: number; level?: number; lives?: number; rows?: Forecast[] } | undefined;
    if (!v || !Number.isSafeInteger(v.frame) || !Number.isInteger(v.level) || !Number.isInteger(v.lives) || !Array.isArray(v.rows) || v.rows.length > 6) return;
    if (!v.rows.every(r => r && typeof r.id === "string" && r.id.length < 160 && typeof r.died === "boolean" && typeof r.partnerDied === "boolean" && Number.isFinite(r.progress) && Math.abs(r.progress) <= 4096 && Number.isFinite(r.separation) && r.separation >= 0 && r.separation <= 256 && r.scenarios === 2)) return;
    this.forecast = { frame: v.frame!, level: v.level!, lives: v.lives!, rows: v.rows };
  }

  planningSnapshot() { return { observation: this.lastObs, memory: structuredClone(this.control.mem), candidates: this.control.candidates }; }

  private lastSource = "";
  private apply(action: Action, src: "jev" | "reflex") {
    const same = sameAction(action, this.last);
    if (same && src === this.lastSource) { this.last = action; return; }
    this.lastSource = src;
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
    if (!this.quiet && !this.tank) {
      try { saveDecisionTrace({ game: this.game.id, usage: this.usage(), diagnostics: this.diagnostics() }); }
      catch (err) { log.warn(`could not save decision trace: ${String(err)}`); }
    }
    if (!this.quiet) log.info(`brain stopped: ticks=${this.stats.ticks} play=${Math.round(this.playMs / 1000)}s jev=${this.stats.jevCalls} tokens=${this.stats.jevIn}/${this.stats.jevOut} deaths=${this.stats.aiDeaths}/${this.stats.humanDeaths} (${Math.round((Date.now() - this.startedAt) / 1000)}s)`);
  }
}
