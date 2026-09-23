import type { GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";
import { canRetreat, edgeAhead, gapAhead, type Decision, type PolicyMemory } from "./policy.js";
import { hopKey, routeAhead } from "./route.js";

export interface Tactic {
  id: string;
  kind: "route" | "regroup" | "cover" | "collect" | "target" | "wait";
  description: string;
  target?: { slot: number; type: number; x: number; y: number };
  binding: { level: number; lives: number; corridor: boolean; partnerAlive: boolean };
}

export interface PlanSelection {
  tactic: Tactic;
  /** Source observation frame, on the client's monotonic emulator clock. */
  frame: number;
  /** Milliseconds left in the original decision horizon, never reset on receipt. */
  ttlMs: number;
  probability: number;
  epoch?: number;
}

/** Feasible goals, not mutually competing emergency button presses. */
export function tacticsFor(game: GameProfile, obs: Observation, mem: PolicyMemory): Tactic[] {
  const binding = { level: obs.level, lives: obs.ai.lives, corridor: obs.corridor, partnerAlive: obs.human.alive };
  const route = routeAhead(game, obs, mem.failedHops);
  const out: Tactic[] = [{ id: route ? `route_${hopKey(route.next)}` : "route", kind: "route", description: obs.corridor ? "Clear the current room using the nearest reachable firing column, then enter the opened wall." : "Follow the mapped route, taking its platform jumps and maintaining safe progress with the partner.", binding }];
  const gap = gapAhead(game, obs, mem, 1);
  const edge = edgeAhead(game, obs, 1);
  const forwardSafe = (!gap || gap.dxStart > 48 || gap.kind === "bridge") && (!edge || edge.dist > 40 || edge.dropOk);
  const backSafe = canRetreat(game, obs, mem, 1);
  if (!obs.corridor && obs.human.alive && Math.abs(obs.human.x - obs.ai.x) > game.reflex.closeDistance && Math.abs(obs.human.y - obs.ai.y) < 28 && (obs.human.x > obs.ai.x ? forwardSafe : backSafe)) {
    out.push({ id: "regroup", kind: "regroup", description: "Close the safe horizontal distance to the partner, firing while moving; stop regrouping once within cover range.", binding });
  }
  if (gap?.kind === "bridge" && !gap.inside && gap.dxStart < 48 && gap.partner === "behind") {
    out.push({ id: "wait_bridge", kind: "wait", description: "Wait on solid ground for the partner so both cross the bridge together. Resume when the partner arrives.", binding });
  }
  const objects = [...obs.enemies].sort((a, b) => Math.abs(a.x - obs.ai.x) - Math.abs(b.x - obs.ai.x));
  for (const e of objects) {
    const dx = e.x - obs.ai.x;
    const dy = e.y - obs.ai.y;
    const target = { slot: e.slot, type: e.type, x: e.x + obs.levelScrollX, y: e.y };
    if (obs.corridor && (e.category === "hostile" || e.category === "obstacle") && e.hp > 1 && dy < 0) {
      out.push({ id: `target_${e.slot}_${e.type}`, kind: "target", description: `Align with this wall target and sustain fire until it disappears. It is ${dx < -6 ? "left" : dx > 6 ? "right" : "aligned"} of the buddy, has ${e.hp} hit points, and is ${obs.human.alive && Math.abs(e.x - obs.human.x) < 16 ? "already aligned with the partner" : "in another firing column"}.`, target, binding });
    } else if (!obs.corridor && e.category === "hostile" && Math.abs(dx) < 120 && Math.abs(dy) < 24 && obs.human.alive && Math.abs(e.x - obs.human.x) < 80 && Math.abs(e.y - obs.human.y) < 40) {
      out.push({ id: `cover_${e.slot}_${e.type}`, kind: "cover", description: `Cover the partner by firing at the hostile ${dx < 0 ? "behind" : "ahead"} on our firing line, until that threat is gone. The partner has ${obs.human.lives} lives.`, target, binding });
    } else if (!obs.corridor && e.category === "item" && Math.abs(dy) < 20 && Math.abs(dx) < 72 && Math.abs(dx) > 8 && (dx > 0 ? forwardSafe : backSafe) && !obs.enemies.some(h => (h.category === "hostile" || h.category === "projectile") && Math.abs(h.x - e.x) < 90 && Math.abs(h.y - e.y) < 64)) {
      out.push({ id: `collect_${e.slot}_${e.type}`, kind: "collect", description: `Collect the reachable weapon item ${dx < 0 ? "behind" : "ahead"}. The area is currently clear; this ${obs.human.alive && Math.abs(e.x - obs.human.x) > 80 ? "separates us from the partner" : "keeps us near the partner"}. Stop once collected.`, target, binding });
    }
    if (out.length >= 6) break;
  }
  return out;
}

export function tacticValid(tactic: Tactic, obs: Observation, candidates: Tactic[]): boolean {
  const b = tactic.binding;
  if (obs.phase !== "playing" || !obs.ai.alive || b.level !== obs.level || b.lives !== obs.ai.lives || b.corridor !== obs.corridor || b.partnerAlive !== obs.human.alive) return false;
  const current = candidates.find(c => c.id === tactic.id);
  if (!current) return false;
  if (tactic.target && (!current.target || Math.abs(current.target.x - tactic.target.x) > 64 || Math.abs(current.target.y - tactic.target.y) > 48)) return false;
  return true;
}

/** Resolve the next bounded step against CURRENT state, never old model coordinates. */
export function executeTactic(game: GameProfile, obs: Observation, mem: PolicyMemory, tactic: Tactic, fallback: Decision): Decision {
  const why = tactic.description;
  if (tactic.kind === "route") return fallback;
  if (tactic.kind === "regroup") return { intent: "follow_partner", why, plan: true };
  if (tactic.kind === "wait") return { intent: "hold_fire", why, plan: true };
  const target = obs.enemies.find(e => e.slot === tactic.target?.slot && e.type === tactic.target.type);
  if (!target) return fallback;
  const dx = target.x - obs.ai.x;
  if (tactic.kind === "target") return { intent: Math.abs(dx) <= 6 ? "hold_fire" : dx > 0 ? "advance_fire" : "retreat", why, plan: true };
  if (tactic.kind === "cover") return { intent: dx >= 0 ? "hold_fire" : "aim_back_fire", why, plan: true };
  return { intent: Math.abs(dx) <= 8 ? "hold_fire" : dx > 0 ? "advance_fire" : "retreat", why, plan: true };
}
