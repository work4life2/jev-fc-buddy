import type { GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";
import type { JevAction } from "./jev.js";

/**
 * The reflex policy: turns an intent (from Jev, the coach, or its own heuristics) plus the current
 * observation into a set of held buttons for the AI's controller. Runs on every tick with zero
 * latency, so the buddy keeps moving sensibly between model answers.
 */

export type Button = "A" | "B" | "SELECT" | "START" | "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface Action {
  hold: Button[];
  /** Buttons to pulse (re-pressed every few frames) instead of holding — semi-auto fire. */
  turbo: Button[];
  tag: string;
  reason: string;
}

export type Intent = JevAction | "auto";

export const IDLE: Action = { hold: [], turbo: [], tag: "idle", reason: "" };

export interface PolicyMemory {
  lastX: number;
  stillSince: number;
  lastJumpAt: number;
}

export function newMemory(): PolicyMemory {
  return { lastX: -1, stillSince: 0, lastJumpAt: 0 };
}

function fwdBack(obs: Observation): { fwd: Button; back: Button } {
  // Vertical levels still move left/right; "forward" then means toward the partner's side.
  if (obs.levelDirection === "up" && obs.human.alive) return obs.human.x >= obs.ai.x ? { fwd: "RIGHT", back: "LEFT" } : { fwd: "LEFT", back: "RIGHT" };
  return { fwd: "RIGHT", back: "LEFT" };
}

/** Pick an intent from heuristics alone (used when Jev has no fresh answer). */
export function heuristicIntent(game: GameProfile, obs: Observation, mem: PolicyMemory, now: number): { intent: Intent; why: string } {
  const r = game.reflex;
  const ai = obs.ai;
  const { fwd } = fwdBack(obs);
  const sign = fwd === "RIGHT" ? 1 : -1;
  const nearest = obs.enemies
    .map((e) => ({ ...e, dx: (e.x - ai.x) * sign, dy: e.y - ai.y }))
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)))[0];

  if (nearest && Math.abs(nearest.dx) < 40 && nearest.dy < -r.aimUpHeight && nearest.dy > -72) return { intent: "aim_up_fire", why: `enemy above (dy ${nearest.dy})` };
  if (nearest && nearest.dx < 0 && nearest.dx > -r.engageDistance && Math.abs(nearest.dy) < 24) return { intent: "retreat", why: `enemy behind (dx ${nearest.dx})` };
  if (nearest && nearest.dx > 0 && nearest.dx < r.closeDistance && Math.abs(nearest.dy) < 16 && ai.onGround && now - mem.lastJumpAt > 900) return { intent: "jump_forward", why: `enemy point-blank (dx ${nearest.dx})` };
  if (nearest && nearest.dx > 0 && nearest.dx < r.engageDistance && Math.abs(nearest.dy) < 24) return { intent: "hold_fire", why: `enemy ahead (dx ${nearest.dx})` };

  if (obs.human.alive) {
    const dxP = (obs.human.x - ai.x) * sign;
    const dyP = obs.human.y - ai.y;
    if (obs.levelDirection === "up" && dyP < -40 && ai.onGround && now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: "partner is above, climb" };
    if (dxP < -r.followDistance) return { intent: "hold_fire", why: `ahead of partner by ${-dxP}px, waiting` };
    if (dxP > r.followDistance * 2) return { intent: "follow_partner", why: `partner ${dxP}px ahead` };
  }
  // Stuck against something while trying to advance: hop.
  if (mem.stillSince && now - mem.stillSince > 1500 && ai.onGround && now - mem.lastJumpAt > 1200) return { intent: "jump_forward", why: "stuck, hopping" };
  return { intent: "advance_fire", why: "path clear" };
}

/** Buttons for an intent. */
export function actionFor(game: GameProfile, obs: Observation, intent: Intent, mem: PolicyMemory, now: number): Action {
  const fire = game.buttons.fire as Button;
  const jump = game.buttons.jump as Button;
  const prone = (game.buttons.prone ?? "DOWN") as Button;
  const up = (game.buttons.aimUp ?? "UP") as Button;
  const turbo = game.reflex.turboFire ? [fire] : [];
  const holdFire = game.reflex.turboFire ? [] : [fire];
  const { fwd, back } = fwdBack(obs);
  const ai = obs.ai;

  // Track standing still for the stuck detector.
  if (ai.x === mem.lastX) mem.stillSince ||= now;
  else mem.stillSince = 0;
  mem.lastX = ai.x;

  switch (intent) {
    case "advance_fire": {
      if (obs.human.alive) {
        const sign = fwd === "RIGHT" ? 1 : -1;
        const dxP = (obs.human.x - ai.x) * sign;
        if (dxP < -game.reflex.followDistance) return { hold: [...holdFire], turbo, tag: "cover", reason: "waiting for partner" };
      }
      return { hold: [fwd, ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "advance" };
    }
    case "follow_partner": {
      if (!obs.human.alive) return { hold: [fwd, ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "no partner, advance" };
      const dx = obs.human.x - ai.x;
      if (Math.abs(dx) <= game.reflex.closeDistance) return { hold: [...holdFire], turbo, tag: "cover", reason: "next to partner" };
      const dir: Button = dx > 0 ? "RIGHT" : "LEFT";
      return { hold: [dir, ...holdFire], turbo, tag: `${dir}+${fire}`, reason: "follow" };
    }
    case "hold_fire":
      return { hold: [...holdFire], turbo, tag: fire, reason: "hold ground" };
    case "aim_up_fire":
      return { hold: [up, ...holdFire], turbo, tag: `${up}+${fire}`, reason: "aim up" };
    case "prone_fire":
      return { hold: [prone, ...holdFire], turbo, tag: `${prone}+${fire}`, reason: "prone" };
    case "jump_forward":
      mem.lastJumpAt = now;
      return { hold: [jump, fwd, ...holdFire], turbo, tag: `${jump}+${fwd}`, reason: "jump forward" };
    case "jump_back":
      mem.lastJumpAt = now;
      return { hold: [jump, back, ...holdFire], turbo, tag: `${jump}+${back}`, reason: "jump back" };
    case "retreat":
      return { hold: [back, ...holdFire], turbo, tag: `${back}+${fire}`, reason: "retreat" };
    default:
      return IDLE;
  }
}

export function sameAction(a: Action, b: Action): boolean {
  return a.hold.join() === b.hold.join() && a.turbo.join() === b.turbo.join();
}
