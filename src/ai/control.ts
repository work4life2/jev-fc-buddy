import type { GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";
import { actionFor, fallSteer, heuristicIntent, IDLE, newMemory, respawnSteer, survivalIntent, type Action, type Button, type Decision, type PolicyMemory } from "./policy.js";
import { hopKey } from "./route.js";
import { executeTactic, tacticValid, tacticsFor, type PlanSelection, type Tactic } from "./tactics.js";

export const PLAN_MAX_AGE_MS = 1800;
export interface ControlStep { action: Action; source: "reflex" | "jev"; plan?: string; interrupted: boolean }

/** The same controller runs next to the emulator and in evaluation. No network or secrets. */
export class GameController {
  mem: PolicyMemory = newMemory();
  candidates: Tactic[] = [];
  epoch = 0;
  private previous?: Observation;
  private active?: { selection: PlanSelection; expires: number };
  private jump?: { intent: "jump_forward" | "jump_back" | "jump_up"; until: number };
  constructor(readonly game: GameProfile) {}

  resetPlan() { this.active = undefined; }

  accept(selection: PlanSelection, obs: Observation, frame: number, now = obs.at): boolean {
    if (!selection?.tactic?.binding || !Number.isFinite(selection.probability)) return false;
    if (selection.epoch !== undefined && selection.epoch !== this.epoch) return false;
    if (!Number.isFinite(selection.ttlMs) || selection.ttlMs <= 0 || selection.ttlMs > PLAN_MAX_AGE_MS || frame < selection.frame || frame - selection.frame > PLAN_MAX_AGE_MS * 0.06 || selection.probability < 0.45) return false;
    if (!tacticValid(selection.tactic, obs, this.candidates)) return false;
    this.active = { selection, expires: now + Math.min(selection.ttlMs, PLAN_MAX_AGE_MS - (frame - selection.frame) * 1000 / 60) };
    return true;
  }

  step(obs: Observation, now = obs.at): ControlStep {
    const prev = this.previous;
    if (prev && (prev.level !== obs.level || prev.phase !== obs.phase || prev.ai.alive !== obs.ai.alive || prev.ai.lives !== obs.ai.lives || prev.corridor !== obs.corridor)) {
      this.epoch++;
      this.resetPlan();
      this.jump = undefined;
      this.mem.commit = undefined;
      this.mem.proneSince = 0;
      if (prev.level !== obs.level) this.mem = newMemory();
    }
    this.previous = obs;
    if (obs.phase !== "playing") {
      this.candidates = [];
      return { action: IDLE, source: "reflex", interrupted: false };
    }
    if (!obs.ai.alive) {
      this.candidates = [];
      if (this.mem.wasAlive) {
        this.mem.fallTarget = undefined;
        if (this.mem.lastHop && now - this.mem.lastHop.at < 2000 && obs.ai.y >= 200) this.mem.failedHops.add(hopKey(this.mem.lastHop.hop));
        this.mem.lastHop = undefined;
      }
      this.mem.wasAlive = false;
      const steer = respawnSteer(this.game, obs, this.mem);
      return { action: steer ? { hold: steer.dir ? [steer.dir] : [], turbo: [], tag: steer.dir ?? "still", reason: steer.why } : IDLE, source: "reflex", interrupted: false };
    }
    // Existing reflex timing is calibrated to the ROM's animation flag, including
    // transitions onto ledges. Keep that hint separate from the physical state sent to Jev.
    const policyObs = { ...obs, ai: { ...obs.ai, onGround: obs.ai.jumpReady ?? obs.ai.onGround } };
    const urgent = survivalIntent(this.game, policyObs, this.mem, now);
    this.mem.fallTicks = this.mem.lastY >= 0 && obs.ai.y - this.mem.lastY >= 4 ? this.mem.fallTicks + 1 : 0;
    this.mem.lastY = obs.ai.y;
    if (!this.mem.wasAlive) this.mem.respawnUntil = now + 1300;
    this.mem.wasAlive = true;
    const falling = this.mem.fallTicks >= 2 || now < this.mem.respawnUntil;
    if (!falling && obs.ai.onGround) this.mem.fallTarget = undefined;
    this.candidates = tacticsFor(this.game, obs, this.mem);
    if (this.active && (now >= this.active.expires || !tacticValid(this.active.selection.tactic, obs, this.candidates))) this.resetPlan();
    if (falling && now - this.mem.lastJumpAt > 1100) {
      const steer = fallSteer(this.game, obs, this.mem);
      if (steer) {
        const fire = this.game.buttons.fire as Button;
        return { action: { hold: steer.dir ? [steer.dir] : [], turbo: this.game.reflex.turboFire ? [fire] : [], tag: `${steer.dir ?? "still"}+${fire}`, reason: steer.why }, source: "reflex", interrupted: !!this.active };
      }
    }
    let decision: Decision = urgent ?? heuristicIntent(this.game, policyObs, this.mem, now);
    let source: "reflex" | "jev" = "reflex";
    const interrupted = !!this.active && !!urgent && !urgent.plan;
    if (this.active && !interrupted) {
      decision = executeTactic(this.game, obs, this.mem, this.active.selection.tactic, decision);
      source = "jev";
    }
    let intent = decision.intent;
    if (intent === "jump_forward" || intent === "jump_back" || intent === "jump_up") this.jump = { intent, until: now + 120 };
    else if (this.jump && now < this.jump.until) intent = this.jump.intent;
    if (this.jump && now >= this.jump.until) this.jump = undefined;
    if (intent !== "prone_fire" && this.mem.proneSince) {
      if (now - this.mem.proneSince < 300 && !urgent) intent = "prone_fire";
      else this.mem.proneSince = 0;
    }
    const action = actionFor(this.game, obs, intent, this.mem, now);
    action.reason = `${decision.why}; executed: ${action.reason}`;
    return { action, source, plan: this.active?.selection.tactic.id, interrupted };
  }
}
