import type { GameProfile } from "../games/registry.js";
import type { EnemyObs, Observation } from "./observe.js";
import type { JevAction } from "./jev.js";

/**
 * The reflex policy: turns an intent (from Jev or its own heuristics) plus the current
 * observation into a set of held buttons for the AI's controller. Runs on every tick with zero
 * latency, so the buddy keeps moving sensibly between model answers.
 *
 * Two layers: `survivalIntent` are hard rules that always win (dodge a projectile, shoot what is
 * about to touch us); `heuristicIntent` is the default plan when no model has a fresh opinion.
 */

export type Button = "A" | "B" | "SELECT" | "START" | "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface Action {
  hold: Button[];
  /** Buttons to pulse (re-pressed every few frames) instead of holding — semi-auto fire. */
  turbo: Button[];
  tag: string;
  reason: string;
}

/** Jev's action set plus policy-internal moves Jev does not need to know about. */
export type Intent = JevAction | "auto" | "aim_diag_fire" | "jump_up";

export const IDLE: Action = { hold: [], turbo: [], tag: "idle", reason: "" };

export interface PolicyMemory {
  lastX: number;
  stillSince: number;
  lastJumpAt: number;
  /** Direction the buddy is believed to face (last horizontal input), +1 right / -1 left. */
  facing: 1 | -1;
  /** While set, a "turn" input is being held so the sprite faces the other way. */
  turnUntil: number;
  proneSince: number;
  /** Level-x positions where ground that gives way was seen (bridges). Gaps stay after the object is gone. */
  gaps: number[];
  level: number;
  /** A positional evasion (leave a shooter, sidestep a fan) is kept for a while so rules do not thrash. */
  commit?: { intent: Intent; why: string; until: number };
  /** Direction of the last "leave the shooter" move, to flip it when it produced no movement. */
  aimedDir?: 1 | -1;
}

export function newMemory(): PolicyMemory {
  return { lastX: -1, stillSince: 0, lastJumpAt: 0, facing: 1, turnUntil: 0, proneSince: 0, gaps: [], level: -1 };
}

/** Remember hazards in level coordinates so the gap they leave behind is still known. */
export function rememberHazards(obs: Observation, mem: PolicyMemory): void {
  if (mem.level !== obs.level) {
    mem.level = obs.level;
    mem.gaps = [];
  }
  for (const e of obs.enemies) {
    if (e.category !== "hazard") continue;
    const lx = obs.levelScrollX + e.x;
    if (!mem.gaps.some((g) => Math.abs(g - lx) < 24)) mem.gaps.push(lx);
  }
}

type Rel = EnemyObs & { dx: number; dy: number; dist: number; approaching: boolean };

function fwdBack(obs: Observation): { fwd: Button; back: Button; sign: 1 | -1 } {
  // Vertical levels still move left/right; "forward" then means toward the partner's side.
  if (obs.levelDirection === "up" && obs.human.alive) return obs.human.x >= obs.ai.x ? { fwd: "RIGHT", back: "LEFT", sign: 1 } : { fwd: "LEFT", back: "RIGHT", sign: -1 };
  return { fwd: "RIGHT", back: "LEFT", sign: 1 };
}

/** Enemies relative to the buddy, in level-forward coordinates (dx > 0 = ahead). */
export function relative(obs: Observation, sign: 1 | -1): Rel[] {
  const ai = obs.ai;
  return obs.enemies
    .map((e) => {
      const dx = (e.x - ai.x) * sign;
      const dy = e.y - ai.y;
      const vxRel = e.vx * sign; // relative to the buddy already (scroll cancelled)
      // Approaching: |dx| shrinking; unknown/slow velocity counts as approaching when already close
      // (a bullet is often seen only once before it is on us).
      const approaching = (dx > 0 && vxRel < 0) || (dx < 0 && vxRel > 0) || (Math.abs(dx) < 40 && Math.abs(e.vx) <= 1);
      return { ...e, dx, dy, dist: Math.abs(dx) + Math.abs(dy), approaching };
    })
    .sort((a, b) => a.dist - b.dist);
}

export interface GapInfo {
  /** Distance (level-forward px) from the buddy to the gap's near edge (negative = inside/past). */
  dxStart: number;
  dxEnd: number;
  width: number;
  inside: boolean;
  partner: "behind" | "near" | "on" | "beyond" | "none";
  /** bridge = crossable while it explodes; pit = never passable at this height. */
  kind: "bridge" | "pit" | "hop";
}

/** The nearest known pit ahead (profile terrain + hazards remembered this level), if within `range`. */
export function gapAhead(game: GameProfile, obs: Observation, mem: PolicyMemory, sign: 1 | -1, range = 200): GapInfo | undefined {
  const profileZones = game.terrain?.gaps?.[String(obs.level)] ?? [];
  // Hand-measured zones win: a learned pit that overlaps one only repeats what the profile already says.
  const learnedPits = (game.learned?.levels[String(obs.level)]?.pits ?? []).filter((p) => !profileZones.some((z) => p[0] <= z[1] + 16 && p[1] >= z[0] - 16));
  const zones: Array<[number, number, GapInfo["kind"]]> = [...profileZones, ...learnedPits]
    .filter((z) => z.length < 4 || (obs.ai.y >= (z[2] as number) && obs.ai.y <= (z[3] as number)))
    .map((z) => [z[0], z[1], (z[4] as GapInfo["kind"] | undefined) ?? "bridge"] as [number, number, GapInfo["kind"]]);
  for (const g of mem.gaps) if (!zones.some(([a, b]) => g >= a - 24 && g <= b + 24)) zones.push([g - 16, g + 16, "bridge"]);
  const me = obs.ai.levelX;
  let best: GapInfo | undefined;
  for (const [a, b, kind] of zones) {
    const start = sign > 0 ? a : b;
    const end = sign > 0 ? b : a;
    const dxStart = (start - me) * sign;
    const dxEnd = (end - me) * sign;
    if (dxEnd < -8 || dxStart > range) continue;
    const inside = dxStart <= 8 && dxEnd >= -8;
    let partner: GapInfo["partner"] = "none";
    if (obs.human.alive) {
      const p = (obs.human.levelX - me) * sign;
      partner = p > dxEnd + 8 ? "beyond" : p >= dxStart - 8 ? "on" : p > dxStart - 72 ? "near" : "behind";
    }
    const info = { dxStart, dxEnd, width: Math.abs(b - a), inside, partner, kind };
    if (!best || info.dxStart < best.dxStart) best = info;
  }
  return best;
}

/**
 * Which jump lands on `landing` from here: a running jump travels JUMP.across px; when that would
 * overshoot a short ledge that already covers us, jump straight up instead. Undefined = neither works yet.
 */
export function jumpKindFor(edge: EdgeInfo, me: number, sign: 1 | -1): "jump_forward" | "jump_up" | "early" | undefined {
  const l = edge.landing;
  if (!l) return undefined;
  const far = sign > 0 ? l.x2 : l.x1; // its far end
  const landsAt = me + sign * (JUMP.across + Math.max(0, l.dy) / JUMP.fallPxPerFrame);
  const short = sign > 0 ? landsAt < l.x1 + 6 : landsAt > l.x2 - 6; // would land before it: keep walking
  const onIt = sign > 0 ? landsAt >= l.x1 + 6 && landsAt <= far - 6 : landsAt <= l.x2 - 6 && landsAt >= far + 6;
  if (onIt) return "jump_forward";
  if (l.dx === 0 && l.dy < 0 && me >= l.x1 + 4 && me <= l.x2 - 4) return "jump_up";
  return short ? "early" : undefined;
}

/** Jump reach, measured in the emulator: 58 px up, ~60 frames, 59 px across on level ground at 1 px/frame. */
const JUMP = { height: 58, across: 59, fallPxPerFrame: 2.5 };

export interface EdgeInfo {
  /** Level-forward px to the end of the platform the buddy stands on. */
  dist: number;
  /** A platform a jump from that edge can land on (nearest), if any. */
  landing?: { x1: number; x2: number; y: number; dy: number; dx: number };
  /** Ground directly below the edge: walking off is a safe drop. */
  dropOk: boolean;
}

/** Where does the ground the buddy stands on end, and what lies beyond? From the learned platform map. */
export function edgeAhead(game: GameProfile, obs: Observation, sign: 1 | -1): EdgeInfo | undefined {
  const platforms = game.learned?.levels[String(obs.level)]?.platforms;
  const badJumps = game.learned?.levels[String(obs.level)]?.badJumps ?? [];
  if (!platforms?.length) return undefined;
  const me = obs.ai.levelX;
  const y = obs.ai.y;
  const here = platforms.find(([a, b, py]) => me >= a - 6 && me <= b + 6 && Math.abs(py - y) <= 4);
  if (!here) return undefined;
  const edgeX = sign > 0 ? here[1] : here[0];
  const dist = (edgeX - me) * sign;
  if (dist > 48) return undefined;
  // Candidates beyond the edge: reachable when the arc gets there. Going up: within the apex; going down: farther.
  let landing: EdgeInfo["landing"];
  let dropOk = false;
  for (const [a, b, py] of platforms) {
    if (py === here[2] && a === here[0]) continue;
    if (badJumps.some((j) => edgeX >= j[0] - 8 && edgeX <= j[1] + 8 && Math.abs(j[2] - y) <= 4 && j[3] === py)) continue; // tried, never arrived
    const near = sign > 0 ? a : b; // its edge facing us
    const dx = (near - edgeX) * sign;
    const dy = py - y;
    if (dx < -8) {
      // Overlaps the edge horizontally: ground straight below → a safe drop; a step up within jump height → a landing.
      const continues = (sign > 0 && b > edgeX + 16) || (sign < 0 && a < edgeX - 16);
      if (dy > 0 && dy < 120 && continues) dropOk = true;
      if (dy < 0 && dy >= -JUMP.height + 6 && continues && (!landing || landing.dy > dy)) landing = { x1: a, x2: b, y: py, dy, dx: 0 };
      continue;
    }
    const reach = dy <= 0 ? (dy >= -JUMP.height + 6 ? JUMP.across - Math.abs(dy) * 0.5 : -1) : JUMP.across + dy / JUMP.fallPxPerFrame;
    if (reach < 0 || dx > reach) continue;
    if (!landing || dx < landing.dx) landing = { x1: a, x2: b, y: py, dy, dx };
  }
  return { dist, landing, dropOk };
}

/** During the respawn fall the buddy can steer: aim for solid ground next to the partner. */
export function respawnSteer(game: GameProfile, obs: Observation, mem: PolicyMemory): { dir: Button; why: string } | undefined {
  if (obs.ai.state !== game.playerState.falling) return undefined;
  const zones = [...(game.terrain?.gaps?.[String(obs.level)] ?? []), ...(game.learned?.levels[String(obs.level)]?.pits ?? [])];
  const me = obs.ai.levelX;
  const zone = zones.map((z) => [z[0], z[1]] as [number, number]).find(([a, b]) => me >= a - 12 && me <= b + 12);
  if (zone) {
    // Over a pit: drift to whichever edge is closer to the partner (or simply the nearer edge).
    const target = obs.human.alive ? (obs.human.levelX >= (zone[0] + zone[1]) / 2 ? zone[1] + 20 : zone[0] - 20) : me - zone[0] < zone[1] - me ? zone[0] - 20 : zone[1] + 20;
    return { dir: target > me ? "RIGHT" : "LEFT", why: `respawning over a pit → drift to ${target > me ? "right" : "left"} edge` };
  }
  if (obs.human.alive && Math.abs(obs.human.levelX - me) > 24) return { dir: obs.human.levelX > me ? "RIGHT" : "LEFT", why: "respawning → drift toward partner" };
  return undefined;
}

interface Threat {
  e: Rel;
  kind: "body" | "low" | "steep";
  /** Ticks until the bullet is level with the buddy (or at its closest point). */
  ticks: number;
  /** Where it crosses the buddy's height (dy at that moment) and its horizontal offset then. */
  yAt: number;
  xAt: number;
}

/**
 * Will this projectile hit, and how? Predicts along its measured velocity; a bullet seen for the
 * first time (velocity unknown) counts as coming straight at us when it is already close.
 */
function threatOf(e: Rel, dodge: number): Threat | undefined {
  const dist = Math.abs(e.dx) + Math.abs(e.dy);
  if (dist > dodge + 40) return undefined;
  const vx = e.vx;
  const vy = e.vy;
  const speed2 = vx * vx + vy * vy;
  if (speed2 === 0) {
    // Unknown velocity: only worry when it is next to us at body height.
    if (Math.abs(e.dx) < 40 && e.dy > -30 && e.dy < 22) return { e, kind: "body", ticks: Math.abs(e.dx) / 3, yAt: e.dy, xAt: e.dx };
    return undefined;
  }
  // Closest approach along the straight path.
  const t = Math.max(0, -(e.dx * vx + e.dy * vy) / speed2);
  if (t > 16) return undefined;
  const cx = e.dx + vx * t;
  const cy = e.dy + vy * t;
  // Hit box: about 12 px wide, from 30 px above the feet down to the feet; be generous.
  if (Math.abs(cx) > 18 || cy < -38 || cy > 26) return undefined;
  if (Math.abs(vy) >= Math.abs(vx) && Math.abs(vy) >= 2) {
    // Rising or diving: where does it cross our height?
    const tc = Math.abs(e.dy / vy);
    return { e, kind: "steep", ticks: tc, yAt: 0, xAt: e.dx + vx * tc };
  }
  const tx = Math.abs(vx) > 0 ? Math.abs(e.dx / vx) : t;
  const yAt = e.dy + vy * Math.min(tx, 16);
  if (yAt < -30 || yAt > 24) return undefined;
  // Prone-safe only when it passes above the waist; anything lower has to be jumped.
  return { e, kind: yAt > 1 ? "low" : "body", ticks: tx, yAt, xAt: 0 };
}

/** A jump lasts ~30 frames and cannot be steered out of a bullet: only jump into clear air. */
function jumpIsSafe(rel: Rel[]): boolean {
  return !rel.some((e) => e.category === "projectile" && Math.abs(e.dx) + Math.abs(e.dy) < 96 && (e.approaching || Math.abs(e.dx) < 32));
}

/** The partner is well ahead: the shared screen cannot scroll until the buddy catches up, so it must keep moving. */
export function lagging(game: GameProfile, obs: Observation, sign: 1 | -1): boolean {
  return obs.human.alive && (obs.human.x - obs.ai.x) * sign > game.reflex.followDistance * 2;
}

/** Can the buddy walk backwards right now? Not at the trailing screen edge, not into a drop or off a ledge. */
export function canRetreat(game: GameProfile, obs: Observation, mem: PolicyMemory, sign: 1 | -1): boolean {
  if (sign > 0 ? obs.ai.x < 28 : obs.ai.x > obs.screen.width - 28) return false;
  const behind = gapAhead(game, obs, mem, (sign * -1) as 1 | -1, 44);
  if (behind && behind.kind !== "bridge" && behind.dxStart < 44) return false;
  const back = edgeAhead(game, obs, (sign * -1) as 1 | -1);
  if (back && !back.dropOk && back.dist < 16) return false;
  return true;
}

/**
 * Standing still at a dead end (edge, pit, waiting to jump) gets the buddy shot when a shooter on
 * another height is in range: back off a few steps instead and come back when the air is clear.
 */
function stopSafely(game: GameProfile, obs: Observation, mem: PolicyMemory, rel: Rel[], sign: 1 | -1, now: number, why: string): { intent: Intent; why: string } {
  const shooters = rel.filter((e) => e.category === "hostile" && Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 120 && isShooter(game, e));
  const bullets = rel.some((e) => e.category === "projectile" && Math.abs(e.dx) + Math.abs(e.dy) < 120);
  // Backing off only helps when it moves us away from the shooter, never back over one behind us.
  const awayIsBack = shooters.length ? shooters.every((e) => e.dx > 16) : bullets;
  if (awayIsBack && canRetreat(game, obs, mem, sign)) {
    mem.commit = { intent: "retreat", why: `${why}; under fire → back off instead of standing`, until: now + 350 };
    return { intent: "retreat", why: mem.commit.why };
  }
  return { intent: "hold_fire", why };
}

/** Enemies that stand and shoot (profile keepDistance list, or anything that takes more than one hit). */
function isShooter(game: GameProfile, e: Rel): boolean {
  const byType = game.enemyTypes?.keepDistance?.[`0x${e.type.toString(16).padStart(2, "0")}`];
  return typeof byType === "number" || e.hp > 1;
}

/**
 * Hard survival rules. Returns undefined when nothing is urgent. These override Jev
 * because a 250 ms model round trip is too slow for a bullet 40 px away.
 */
export function survivalIntent(game: GameProfile, obs: Observation, mem: PolicyMemory, now: number): { intent: Intent; why: string } | undefined {
  const r = game.reflex;
  const ai = obs.ai;
  const { sign } = fwdBack(obs);
  const rel = relative(obs, sign);
  const dodge = r.dodgeDistance ?? 64;

  // 0. Ground that gives way (exploding bridge). On it: keep moving. Ahead of it: sprint so we cross
  //    together with the partner (a lagging player finds the bridge already gone). Where one used
  //    to be and nothing is left: jump the gap from its edge (best effort).
  rememberHazards(obs, mem);
  const hazard = rel.find((e) => e.category === "hazard" && Math.abs(e.dx) < 40 && e.dy > -8 && e.dy < 48);
  if (hazard) {
    if (mem.stillSince && now - mem.stillSince > 250 && ai.onGround && now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: `hazard underfoot (dx ${hazard.dx}) → jump clear` };
    return { intent: "advance_fire", why: `hazard underfoot (dx ${hazard.dx}) → keep moving` };
  }
  if (mem.commit && now < mem.commit.until) {
    const dir: 1 | -1 = mem.commit.intent === "retreat" ? -1 : 1;
    const e = edgeAhead(game, obs, (sign * dir) as 1 | -1);
    const g = gapAhead(game, obs, mem, (sign * dir) as 1 | -1, 40);
    const blocked = (e && !e.dropOk && e.dist < 14) || (g && g.kind !== "bridge" && g.dxStart < 14);
    if (!blocked) return { intent: mem.commit.intent, why: mem.commit.why };
  }
  mem.commit = undefined;
  // 1. Projectiles. Enemy shots are aimed at where the buddy stands, so the dodge depends on the
  //    bullet's path, not on where it came from: predict its closest approach and leave that line.
  //      horizontal at body height → lie prone (it flies over a prone body)
  //      horizontal and low        → jump it (only when the air above is clear)
  //      rising / diving           → sidestep: prone puts the body in a rising shot, a jump into a diving one
  const threats = rel.filter((e) => e.category === "projectile").map((e) => threatOf(e, dodge)).filter((t): t is Threat => t !== undefined);
  threats.sort((a, b) => a.ticks - b.ticks);
  const body = threats.find((t) => t.kind === "body");
  const low = threats.find((t) => t.kind === "low");
  const steep = threats.find((t) => t.kind === "steep");
  if (steep && (!body || steep.ticks <= body.ticks)) {
    // Move away from where the bullet crosses our height; keep that direction so rules do not thrash.
    let drift: 1 | -1 = steep.xAt > 2 ? -1 : steep.xAt < -2 ? 1 : 1;
    const shooter = rel.find((e) => e.category === "hostile" && Math.abs(e.dy) > 24 && Math.abs(e.dx) < 120);
    if (Math.abs(steep.xAt) <= 2 && shooter) drift = shooter.dx > 0 ? -1 : 1; // dead vertical: step away from the shooter
    const c = { intent: (drift === sign ? "advance_fire" : "retreat") as Intent, why: `${steep.e.vy < 0 ? "rising" : "diving"} shot (dx ${steep.e.dx}, dy ${steep.e.dy}, v ${steep.e.vx}/${steep.e.vy}) → step ${drift > 0 ? "right" : "left"}`, until: now + 400 };
    mem.commit = c;
    return { intent: c.intent, why: c.why };
  }
  if (body || low) {
    if (!ai.onGround) return undefined; // mid-air: nothing to be done
    if (body) return { intent: "prone_fire", why: `bullet incoming (dx ${body.e.dx}, y@ ${body.yAt.toFixed(0)})` };
    // A low shot has to be jumped, and the jump (60 frames) must be timed: too early and we land on it.
    const l = low!;
    if (l.ticks <= 6) return { intent: "jump_forward", why: `low shot (dx ${l.e.dx}, y@ ${l.yAt.toFixed(0)}, ${l.ticks.toFixed(0)} ticks) → jump${jumpIsSafe(rel) ? "" : " (air not clear, no choice)"}` };
    if (l.ticks <= 12) return { intent: "hold_fire", why: `low shot (dx ${l.e.dx}, ${l.ticks.toFixed(0)} ticks) → jump at the last moment` };
    // Not yet: keep our distance from it in one direction (no thrashing) until it is in the jump window.
    const away: 1 | -1 = l.e.dx > 0 ? -1 : 1;
    const dir: 1 | -1 = away < 0 && !canRetreat(game, obs, mem, sign) ? 1 : away;
    mem.commit = { intent: dir === sign ? "advance_fire" : "retreat", why: `low shot far (dx ${l.e.dx}, ${l.ticks.toFixed(0)} ticks) → ${dir === away ? "back off" : "cannot back off, push on"}`, until: now + 300 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  // 1b. A hostile dropping onto us from a ledge above (soldiers jump down): step back out from under it.
  const diver = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 28 && e.dy < -12 && e.dy > -56 && e.vy > 0);
  if (diver && Math.abs(diver.dx) < 12 && diver.hp <= 1) return { intent: "aim_up_fire", why: `hostile dropping onto us (dx ${diver.dx}, dy ${diver.dy}) → shoot up` };
  if (diver) {
    if (!canRetreat(game, obs, mem, sign)) {
      if (Math.abs(diver.dx) < 16) return { intent: "aim_up_fire", why: `hostile dropping onto us (dx ${diver.dx}), no way back → shoot up` };
      // Lagging behind the partner locks the screen for both: walk into the fire line while shooting instead of standing.
      if (diver.dx > 12 && lagging(game, obs, sign) && diver.hp <= 1) return { intent: "advance_fire", why: `hostile dropping in ahead (dx ${diver.dx}), partner waits on us → shoot it on the move` };
      return { intent: diver.dx > 0 ? "hold_fire" : "retreat", why: `hostile dropping in ${diver.dx > 0 ? "ahead" : "behind"} (dx ${diver.dx}), no way back → face it and fire` };
    }
    if (ai.onGround && now - mem.lastJumpAt > 900 && jumpIsSafe(rel)) return { intent: "jump_back", why: `hostile dropping in (dx ${diver.dx}, dy ${diver.dy}) → hop back` };
    return { intent: "retreat", why: `hostile dropping in (dx ${diver.dx}, dy ${diver.dy})` };
  }
  // 1c. The platform ends ahead (learned map). Prefer a jump to a platform at the same height or higher
  //     (the high road has fewer pits); walk off only onto ground straight below; never off into nothing.
  const edge = edgeAhead(game, obs, sign);
  const partnerBehind = obs.human.alive && (obs.human.x - ai.x) * sign < -16;
  const knownDrop = gapAhead(game, obs, mem, sign, 60);
  if (edge && ai.onGround) {
    const up = edge.landing !== undefined && edge.landing.dy <= 0;
    if (edge.landing && (up || !edge.dropOk)) {
      if (partnerBehind && edge.dist <= 10) return stopSafely(game, obs, mem, rel, sign, now, `platform ends, partner behind → wait here`);
      // Take off as soon as a running jump reaches the next ledge (before the edge when it is close), never past it.
      const kind = jumpKindFor(edge, ai.levelX, sign);
      if (!partnerBehind && edge.dist > -6 && kind !== "early") {
        if (kind && (jumpIsSafe(rel) || edge.dist <= 2)) return { intent: kind, why: `platform ends → ${kind === "jump_up" ? "jump straight up onto the ledge" : "jump to the next one"} (dx ${edge.landing.dx.toFixed(0)}, dy ${edge.landing.dy})` };
        if (kind) return stopSafely(game, obs, mem, rel, sign, now, `platform ends, bullets in the air → wait before jumping`);
        if (edge.dist <= 10) return stopSafely(game, obs, mem, rel, sign, now, `platform ends, no jump lands on the next ledge from here → stop`);
      }
    } else if (!edge.dropOk && edge.dist <= 14) {
      if (partnerBehind) return stopSafely(game, obs, mem, rel, sign, now, `platform ends (${edge.dist.toFixed(0)}px), partner behind → wait here`);
      if (knownDrop && knownDrop.kind === "hop") return undefined; // the hop rule below takes it from the edge
      if (knownDrop && knownDrop.kind === "pit") {
        if (obs.human.alive && obs.human.y < ai.y - 40 && now - mem.lastJumpAt > 900 && jumpIsSafe(rel)) return { intent: "jump_forward", why: `dead end, partner above → try to climb` };
        return stopSafely(game, obs, mem, rel, sign, now, `platform ends over a known drop, nothing to land on → stop`);
      }
      // Nothing known beyond: jump and find out (once it kills us it becomes a known drop).
      if (edge.dist <= 6 && now - mem.lastJumpAt > 900 && jumpIsSafe(rel)) return { intent: "jump_forward", why: `platform ends, nothing known beyond → jump and see` };
      if (edge.dist <= 6) return stopSafely(game, obs, mem, rel, sign, now, `platform ends, bullets in the air → wait`);
    }
  }
  // 1d. A shooter on another height (below a ledge, on a ledge above) aims at wherever we stand:
  //     never stand still within its reach, and never directly above or below it.
  const aimed = rel.find((e) => e.category === "hostile" && Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 110 && isShooter(game, e));
  if (aimed && ai.onGround) {
    const still = mem.stillSince ? now - mem.stillSince : 0;
    if (Math.abs(aimed.dx) < 16 || still > 350) {
      // Leave: forward when it is behind or nearly under us, else back out of its reach.
      // Through, not back and forth: run past it (its shots land where we were), back only to stay with the partner.
      const partnerSide: 1 | -1 = obs.human.alive ? ((obs.human.x - ai.x) * sign >= 0 ? 1 : -1) : 1;
      let dir: 1 | -1 | 0 = partnerSide < 0 && aimed.dx > 16 ? -1 : 1;
      // Still standing after the last move in that direction: something blocks it, go the other way.
      if (still > 900 && mem.aimedDir === dir && aimed.dx > 24) dir = (dir * -1) as 1 | -1; // never back over a shooter that is behind/below us
      if (dir < 0 && !canRetreat(game, obs, mem, sign)) dir = 1; // nowhere to go back to: run past it instead
      if (dir > 0 && edge && !edge.dropOk && !edge.landing && edge.dist < 24) dir = canRetreat(game, obs, mem, sign) ? -1 : 0; // never off the ledge
      if (dir !== 0) {
        mem.aimedDir = dir;
        mem.commit = { intent: dir === sign ? "advance_fire" : "retreat", why: `shooter ${aimed.dy > 0 ? "below" : "above"} (dx ${aimed.dx}, dy ${aimed.dy}) aims at us → keep moving ${dir > 0 ? "on" : "back"}`, until: now + 450 };
        return { intent: mem.commit.intent, why: mem.commit.why };
      }
    }
  }
  // 2. Hostile in touching range at our height: face it and shoot; if it is about to touch, hop back.
  const touch = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < r.closeDistance && Math.abs(e.dy) < 20);
  if (touch) {
    if (touch.approaching && ai.onGround && now - mem.lastJumpAt > 900 && Math.abs(touch.dx) < 20) return { intent: "jump_back", why: `hostile about to touch (dx ${touch.dx}) → hop back` };
    if (touch.dx < 0) return { intent: "retreat", why: `hostile behind (dx ${touch.dx})` };
    if (touch.dx > 12 && touch.hp <= 1 && lagging(game, obs, sign)) return { intent: "advance_fire", why: `hostile close ahead (dx ${touch.dx}), partner waits on us → shoot it on the move` };
    return { intent: "hold_fire", why: `hostile close ahead (dx ${touch.dx})` };
  }
  // 2b. Pits (bridges that explode once crossed). Inside: never stop. Ahead: cross together with the
  //     partner; if the partner is already far beyond, the bridge is gone — do not walk in.
  const gap = gapAhead(game, obs, mem, sign);
  if (gap && gap.kind === "hop") {
    // A narrow drop: run at it and jump from the edge; never stop on the edge.
    if (gap.inside && !ai.onGround) return undefined;
    // A running jump covers ~59 px: take off so that it lands past the far edge, not at its start.
    const takeoff = Math.max(4, Math.min(24, JUMP.across - gap.width - 12));
    // The learned ledge end is more precise than the zone: never run past it before pressing jump.
    const atLedge = edge !== undefined && !edge.dropOk && edge.dist <= 12 && gap.dxStart <= 40;
    if ((gap.dxStart <= takeoff || atLedge) && gap.dxStart > -6) {
      // At the very edge press jump again even inside the throttle: a press that came a pixel late did nothing.
      if (ai.onGround && (now - mem.lastJumpAt > 300 || gap.dxStart <= 6 || (edge !== undefined && edge.dist <= 4)) && (jumpIsSafe(rel) || gap.dxStart <= 6)) return { intent: "jump_forward", why: `drop ahead (dx ${gap.dxStart.toFixed(0)}, ${gap.width}px) → jump` };
      return stopSafely(game, obs, mem, rel, sign, now, `drop ahead (dx ${gap.dxStart.toFixed(0)}) but cannot jump now → wait at the edge`);
    }
    if (gap.dxStart <= 60) return { intent: "advance_fire", why: `drop in ${gap.dxStart.toFixed(0)}px → run up to it` };
  } else if (gap && gap.kind === "pit") {
    // Dead end at this height: never walk in; get up to the partner's ledge instead.
    if (gap.dxStart < 40) {
      if (edge?.dropOk) return undefined; // ground straight below the edge: walking off is fine
      const kind = edge ? jumpKindFor(edge, ai.levelX, sign) : undefined;
      if (kind === "early") return undefined;
      if (edge?.landing && kind && ai.onGround && now - mem.lastJumpAt > 600 && (jumpIsSafe(rel) || gap.dxStart < 8)) return { intent: kind, why: `pit ahead (dx ${gap.dxStart.toFixed(0)}) → ${kind} to the platform at dy ${edge.landing.dy}` };
      if (obs.human.alive && obs.human.y < ai.y - 40 && ai.onGround && now - mem.lastJumpAt > 900) return { intent: "jump_forward", why: `pit ahead (dx ${gap.dxStart.toFixed(0)}), partner above → try to climb` };
      return stopSafely(game, obs, mem, rel, sign, now, `pit ahead (dx ${gap.dxStart.toFixed(0)}) → stop, this route ends here`);
    }
  } else if (gap) {
    if (gap.inside) return { intent: "advance_fire", why: `on the bridge (${gap.dxEnd.toFixed(0)}px to go) → keep moving` };
    if (gap.dxStart < 24) {
      if (gap.partner === "beyond" && !rel.some((e) => e.category === "hazard")) return { intent: "hold_fire", why: `pit ahead (${gap.width}px), bridge gone → wait at the edge` };
      if (gap.partner === "on" || gap.partner === "near" || rel.some((e) => e.category === "hazard")) return { intent: "advance_fire", why: `bridge edge, partner ${gap.partner} → cross now` };
      return { intent: "hold_fire", why: `bridge edge, partner ${gap.partner} → wait, cross together` };
    }
    if (gap.partner === "on" || (gap.partner === "near" && obs.human.xVel === sign)) return { intent: "advance_fire", why: `bridge in ${gap.dxStart.toFixed(0)}px, partner crossing → sprint` };
  }
  // 2c. Something that cannot be one-shot (turret, wall sensor, hp > 1) close by: keep 56+ px away.
  const keep = (e: Rel): number => {
    const byType = game.enemyTypes?.keepDistance?.[`0x${e.type.toString(16).padStart(2, "0")}`];
    if (typeof byType === "number") return byType;
    return e.hp > 1 ? 72 : 0;
  };
  const heavy = rel.find((e) => e.category === "hostile" && keep(e) > 0 && Math.abs(e.dx) < keep(e) && e.dy > -28 && e.dy < 24);
  if (heavy) {
    mem.commit = { intent: heavy.dx >= 0 ? "retreat" : "advance_fire", why: `stationary shooter #${heavy.type.toString(16)} at dx ${heavy.dx}, dy ${heavy.dy} → keep ${keep(heavy)}px`, until: now + 500 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  // 3. Sniper / turret above us: straight up when overhead, diagonal when it is ahead and above.
  const above = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  // Very close overhead, or a turret that cannot be one-shot (hp > 1): do not stand under it.
  if (above && above.dy > -44) {
    if (canRetreat(game, obs, mem, sign)) return { intent: "retreat", why: `hostile right overhead (dx ${above.dx}, dy ${above.dy}) → step back` };
    mem.commit = { intent: "advance_fire", why: `hostile right overhead (dx ${above.dx}, dy ${above.dy}), no way back → run out from under it`, until: now + 500 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  return undefined;
}

/** Default plan when no model has a fresh opinion. */
export function heuristicIntent(game: GameProfile, obs: Observation, mem: PolicyMemory, now: number): { intent: Intent; why: string } {
  const r = game.reflex;
  const ai = obs.ai;
  const { sign } = fwdBack(obs);
  const rel = relative(obs, sign);
  const hostile = rel.filter((e) => e.category === "hostile");
  const items = rel.filter((e) => e.category === "item");

  // Weapon capsule flying past above: shoot it down. Weapon item on the ground nearby: go get it.
  const capsule = items.find((e) => e.type === 3 && Math.abs(e.dx) < 56 && e.dy < -16 && e.dy > -96);
  if (capsule) return { intent: "aim_up_fire", why: "shoot the weapon capsule" };
  // A power-up is not worth a detour into a shooter's reach.
  const shooterInReach = hostile.some((e) => Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 110 && isShooter(game, e));
  const partnerBehindUs = obs.human.alive && (obs.human.x - ai.x) * sign < -16;
  const pickup = items.find((e) => e.type !== 3 && Math.abs(e.dx) < (r.itemDistance ?? 96) && Math.abs(e.dy) < 48 && hostile.every((h) => h.dist > 48) && !shooterInReach && (e.dx >= 0 || partnerBehindUs));
  if (pickup) return { intent: pickup.dx >= 0 ? "advance_fire" : "retreat", why: `weapon item ${pickup.dx >= 0 ? "ahead" : "behind"} (dx ${pickup.dx})` };

  // Cover the partner: an enemy close to them that we can hit from here comes before our own targets.
  if (obs.human.alive) {
    const threat = hostile
      .filter((e) => Math.abs(e.x - obs.human.x) < 80 && Math.abs(e.y - obs.human.y) < 40 && e.dist < r.engageDistance * 1.5)
      .sort((a, b) => Math.abs(a.x - obs.human.x) - Math.abs(b.x - obs.human.x))[0];
    if (threat) {
      if (Math.abs(threat.dy) < 24) return { intent: threat.dx >= 0 ? "hold_fire" : "retreat", why: `covering partner: hostile ${threat.dx >= 0 ? "ahead" : "behind"} of us near them (dx ${threat.dx})` };
      if (threat.dy < -r.aimUpHeight && threat.dy > -100 && threat.dx >= 0 && threat.dx < 96) return { intent: Math.abs(threat.dx) < 24 ? "aim_up_fire" : "aim_diag_fire", why: `covering partner: hostile above (dx ${threat.dx}, dy ${threat.dy})` };
    }
  }
  const above = hostile.find((e) => Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  if (above && above.hp > 1) {
    // A turret cannot be shot from here: run out from under it in one go (back only to stay with a partner behind).
    const partnerBehind = obs.human.alive && (obs.human.x - ai.x) * sign < -16;
    const back = partnerBehind && canRetreat(game, obs, mem, sign);
    mem.commit = { intent: back ? "retreat" : "advance_fire", why: `turret overhead (hp ${above.hp}) → run ${back ? "back" : "past it"}`, until: now + 600 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  if (above) return { intent: "aim_up_fire", why: `hostile above (dy ${above.dy})` };
  const diag = hostile.find((e) => e.dx >= 24 && e.dx < 96 && e.dy < -r.aimUpHeight && e.dy > -100 && Math.abs(Math.abs(e.dx) - Math.abs(e.dy)) < 40);
  if (diag) return { intent: "aim_diag_fire", why: `hostile up-ahead (dx ${diag.dx}, dy ${diag.dy}) → diagonal` };
  const ahead = hostile.find((e) => e.dx > 0 && e.dx < r.engageDistance && Math.abs(e.dy) < 24);
  if (ahead) {
    // Standing still is what gets the buddy shot when a sniper on another height is aiming: keep walking
    // (turbo fire kills a runner just the same) and only plant the feet when it is close.
    const underAim = hostile.some((e) => Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 110 && isShooter(game, e));
    const stand = (ahead.approaching || ahead.hp > 1) && !(underAim && ahead.dx > 48 && ahead.hp <= 1) && !(lagging(game, obs, sign) && ahead.hp <= 1 && ahead.dx > 24);
    return { intent: stand ? "hold_fire" : "advance_fire", why: `hostile ahead (dx ${ahead.dx}${ahead.approaching ? ", closing" : ""})${underAim && !stand ? ", under aimed fire → keep moving" : ""}` };
  }
  const behind = hostile.find((e) => e.dx < 0 && e.dx > -r.engageDistance && Math.abs(e.dy) < 24 && e.approaching);
  if (behind) return { intent: "retreat", why: `hostile behind (dx ${behind.dx})` };

  if (obs.human.alive) {
    const dxP = (obs.human.x - ai.x) * sign;
    const dyP = obs.human.y - ai.y;
    const shooterNear = hostile.some((e) => Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 100 && isShooter(game, e));
    if (dyP < -40 && Math.abs(dxP) < 96 && ai.onGround && now - mem.lastJumpAt > 900 && jumpIsSafe(rel) && !shooterNear) return { intent: "jump_forward", why: `partner is ${-dyP}px above → try to climb` };
    if (dxP < -r.followDistance) return { intent: "hold_fire", why: `ahead of partner by ${-dxP}px, covering` };
    if (dxP > r.followDistance * 2) return { intent: "follow_partner", why: `partner ${dxP}px ahead` };
  }
  // Stuck against something while trying to advance: hop.
  if (mem.stillSince && now - mem.stillSince > 1500 && ai.onGround && now - mem.lastJumpAt > 1200) {
    const edge = edgeAhead(game, obs, sign);
    if ((!edge || edge.dropOk || edge.landing || edge.dist > 40) && jumpIsSafe(rel)) return { intent: "jump_forward", why: "stuck, hopping" };
  }
  return { intent: "advance_fire", why: "path clear" };
}

/** Buttons for an intent. */
export function actionFor(game: GameProfile, obs: Observation, intent: Intent, mem: PolicyMemory, now: number): Action {
  // At the trailing screen edge the shared screen cannot scroll: backing off further only jams the
  // game for both players, so turn a retreat into standing fire / a jump-back into a jump-forward.
  const edgeSign = obs.levelDirection === "up" && obs.human.alive ? (obs.human.x >= obs.ai.x ? 1 : -1) : 1;
  const atTrailingEdge = edgeSign > 0 ? obs.ai.x < 28 : obs.ai.x > obs.screen.width - 28;
  // Never back off into a drop behind us: stand and fire instead.
  if (intent === "retreat" || intent === "jump_back") {
    const behind = gapAhead(game, obs, mem, (edgeSign * -1) as 1 | -1, 44);
    if (behind && behind.kind !== "bridge" && behind.dxStart < 44) intent = "hold_fire";
    const back = edgeAhead(game, obs, (edgeSign * -1) as 1 | -1);
    if (back && !back.dropOk && back.dist < 16) intent = "hold_fire";
  }
  if (atTrailingEdge && intent === "retreat") {
    const upAhead = relative(obs, edgeSign as 1 | -1).find((e) => e.category === "hostile" && e.dx > 0 && e.dx < 110 && e.dy < -24 && e.dy > -100);
    intent = upAhead ? "aim_diag_fire" : "hold_fire";
  }
  if (atTrailingEdge && intent === "jump_back") {
    const hostileAhead = relative(obs, edgeSign as 1 | -1).some((e) => e.category === "hostile" && e.dx > -8 && e.dx < 48 && Math.abs(e.dy) < 40);
    intent = hostileAhead ? "hold_fire" : "jump_forward";
  }
  const fire = game.buttons.fire as Button;
  const jump = game.buttons.jump as Button;
  const prone = (game.buttons.prone ?? "DOWN") as Button;
  const up = (game.buttons.aimUp ?? "UP") as Button;
  const turbo = game.reflex.turboFire ? [fire] : [];
  const holdFire = game.reflex.turboFire ? [] : [fire];
  const { fwd, back, sign } = fwdBack(obs);
  const ai = obs.ai;

  // Track standing still for the stuck detector and the facing direction.
  if (ai.x === mem.lastX) mem.stillSince ||= now;
  else mem.stillSince = 0;
  mem.lastX = ai.x;
  if (ai.xVel !== 0) mem.facing = ai.xVel > 0 ? 1 : -1;
  const walk = (dir: Button): Button[] => {
    mem.facing = dir === "RIGHT" ? 1 : -1;
    return [dir];
  };
  /**
   * Shoot in a direction without walking into it: tap the direction just long enough to turn the
   * sprite (Contra keeps facing the last direction pressed), then fire standing still.
   */
  const partnerMovingForward = obs.human.alive && obs.human.xVel === sign;
  const face = (dir: 1 | -1, reason: string, tagBase: string): Action => {
    // A partner who keeps walking forward drags the screen (and explodes bridges behind them):
    // never stand still then, walk along instead.
    if (partnerMovingForward && dir === sign) return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: `${reason}, partner moving → keep up` };
    const key: Button = dir > 0 ? "RIGHT" : "LEFT";
    if (mem.facing !== dir && !mem.turnUntil) mem.turnUntil = now + 130;
    if (mem.turnUntil && now < mem.turnUntil) return { hold: [key, ...holdFire], turbo, tag: `${tagBase}:turn`, reason: `${reason} (turning)` };
    mem.turnUntil = 0;
    mem.facing = dir;
    return { hold: [...holdFire], turbo, tag: tagBase, reason };
  };

  switch (intent) {
    case "advance_fire": {
      const onHazard = relative(obs, sign).some((e) => e.category === "hazard" && Math.abs(e.dx) < 40 && e.dy > -8 && e.dy < 48);
      if (obs.human.alive && !ai.invincible && !onHazard) {
        const dxP = (obs.human.x - ai.x) * sign;
        if (dxP < -game.reflex.followDistance) return face(sign, "waiting for partner", "cover");
      }
      return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "advance" };
    }
    case "follow_partner": {
      if (!obs.human.alive) return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "no partner, advance" };
      const dx = obs.human.x - ai.x;
      if (Math.abs(dx) <= game.reflex.closeDistance) return face(sign, "next to partner", "cover");
      const dir: Button = dx > 0 ? "RIGHT" : "LEFT";
      return { hold: [...walk(dir), ...holdFire], turbo, tag: `${dir}+${fire}`, reason: "follow" };
    }
    case "hold_fire":
      return face(sign, "hold ground", fire);
    case "aim_up_fire":
      return { hold: [up, ...holdFire], turbo, tag: `${up}+${fire}`, reason: "aim up" };
    case "aim_diag_fire":
      // UP + forward fires diagonally; we drift forward a little, which is acceptable at 24+ px range.
      return { hold: [up, ...walk(fwd), ...holdFire], turbo, tag: `${up}+${fwd}+${fire}`, reason: "aim diagonal" };
    case "prone_fire":
      mem.proneSince ||= now;
      return { hold: [prone, ...holdFire], turbo, tag: `${prone}+${fire}`, reason: "prone" };
    case "jump_forward":
      mem.lastJumpAt = now;
      return { hold: [jump, ...walk(fwd), ...holdFire], turbo, tag: `${jump}+${fwd}`, reason: "jump forward" };
    case "jump_back":
      mem.lastJumpAt = now;
      return { hold: [jump, ...walk(back), ...holdFire], turbo, tag: `${jump}+${back}`, reason: "jump back" };
    case "jump_up":
      // Straight up onto the ledge overhead (ledges can be entered from below).
      mem.lastJumpAt = now;
      return { hold: [jump, ...holdFire], turbo, tag: jump, reason: "jump up" };
    case "retreat": {
      // Something is behind us: face it and shoot; only actually walk back when it is not adjacent.
      const rel = relative(obs, sign);
      const behind = rel.find((e) => e.category === "hostile" && e.dx < 0 && Math.abs(e.dy) < 24);
      if (behind && Math.abs(behind.dx) < 48) return face((-sign) as 1 | -1, "shoot behind", `${back}:${fire}`);
      return { hold: [...walk(back), ...holdFire], turbo, tag: `${back}+${fire}`, reason: "retreat" };
    }
    default:
      return IDLE;
  }
}

export function sameAction(a: Action, b: Action): boolean {
  return a.hold.join() === b.hold.join() && a.turbo.join() === b.turbo.join();
}
