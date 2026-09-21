import type { GameProfile } from "../games/registry.js";
import { DIR_DX, DIR_DY, type Dir, type Observation, type ShellObs, type TankObs, type TankWorld, type Terrain } from "./observe.js";
import type { Action, Button } from "./policy.js";

/**
 * Reflex policy for top-down tank arenas (genre "tank"). Everything happens on an 8 px lattice:
 * tanks are 16x16 bodies whose centre snaps to the lattice, shells fly along lattice lanes and stop
 * at the first brick/steel cell, and two shells that meet destroy each other.
 *
 * Order of business every tick:
 *   1. survive  — a shell that will hit us: shoot it down when we face it, otherwise step out of
 *                 its lane, otherwise turn into it and fire;
 *   2. duel     — an enemy that faces us down an open lane will fire: face it and fire first;
 *   3. protect  — never fire along a lane that ends in the base or its wall;
 *   4. attack   — walk (BFS) to the nearest position with an open lane onto an enemy and fire;
 *   5. collect  — power-ups when nothing is shooting at us;
 *   6. otherwise hold a post between the enemies and the base.
 * The strategic intent (Jev / coach) only re-weights step 4 and 5; steps 1-3 always win.
 */

export type TankIntent = "engage" | "defend_base" | "hold_fire" | "evade" | "collect_item" | "support_partner";

export const TANK_INTENTS: Record<TankIntent, string> = {
  engage: "Move to a firing position against the nearest enemy tank and destroy it.",
  defend_base: "Fall back toward the base (the eagle) and destroy the enemies closest to it.",
  hold_fire: "Stay where the buddy is, face the nearest threat and fire; do not advance.",
  evade: "Break every enemy line of fire: leave the lanes enemies are facing down and keep distance.",
  collect_item: "Drive to the power-up lying on the field and pick it up.",
  support_partner: "Move toward the human partner and destroy the enemies threatening them.",
};

const BUTTON: Record<Dir, Button> = { 0: "UP", 1: "LEFT", 2: "DOWN", 3: "RIGHT" };
const opposite = (d: Dir): Dir => (((d + 2) & 3) as Dir);
const DIRS: Dir[] = [0, 1, 2, 3];

export interface TankMemory {
  /** Direction our tank faces (the last direction pressed). */
  facing: Dir;
  /** Last known facing per tank slot (a standing tank's sprite does not tell). */
  lastDir: Map<number, Dir>;
  lastPos: { x: number; y: number; at: number };
  /** A forced detour after being blocked (usually by another tank). */
  detour?: { dir: Dir; until: number };
  /** A sidestep in progress: kept until the shell is clearly missed, so the tank does not walk back into the lane. */
  dodge?: { dir: Dir; shellSlot: number; shellDir: Dir; until: number };
  /** Leaving the lane of an enemy that faces us: kept until we are clear of it. */
  evade?: { dir: Dir; slot: number; laneDir: Dir; until: number };
  /** Current plan, kept so the buddy does not flip between equally good targets every tick. */
  plan?: { kind: "fire" | "item" | "post" | "dig"; x: number; y: number; slot?: number; since: number };
  lastFireAt: number;
}

export function newTankMemory(): TankMemory {
  return { facing: 0, lastDir: new Map(), lastPos: { x: -1, y: -1, at: 0 }, lastFireAt: 0 };
}

// ───────────────────────── geometry ─────────────────────────

const solidForTank = (t: Terrain): boolean => t !== "empty" && t !== "trees" && t !== "ice";
const stopsShell = (t: Terrain): boolean => t === "brick" || t === "steel" || t === "border" || t === "eagle" || t === "eagleDestroyed";

function terrainAt(w: TankWorld, cx: number, cy: number): Terrain {
  if (cx < 0 || cy < 0 || cx >= w.stride || cy >= 30) return "border";
  return w.terrainOf(w.cells[cy * w.stride + cx]);
}

/** Cells covered by a 16x16 body centred at (x, y); 4 when on the lattice, up to 9 in between. */
function bodyCells(w: TankWorld, x: number, y: number): Array<[number, number]> {
  const c = w.cell;
  const out: Array<[number, number]> = [];
  const cx0 = Math.floor((x - 8) / c);
  const cx1 = Math.floor((x + 7) / c);
  const cy0 = Math.floor((y - 8) / c);
  const cy1 = Math.floor((y + 7) / c);
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push([cx, cy]);
  return out;
}

function inField(w: TankWorld, x: number, y: number): boolean {
  return x >= w.field.x0 + 8 && x <= w.field.x1 - 8 && y >= w.field.y0 + 8 && y <= w.field.y1 - 8;
}

/** Can a tank stand centred at (x, y)? Other alive tanks count as walls (except `ignoreSlot`). */
function canStand(w: TankWorld, x: number, y: number, ignoreSlot: number): boolean {
  if (!inField(w, x, y)) return false;
  for (const [cx, cy] of bodyCells(w, x, y)) if (solidForTank(terrainAt(w, cx, cy))) return false;
  for (const t of w.tanks) {
    if (t.slot === ignoreSlot || !t.alive) continue;
    if (Math.abs(t.x - x) < 16 && Math.abs(t.y - y) < 16) return false;
  }
  return true;
}

const snap8 = (v: number): number => Math.round(v / 8) * 8;

/**
 * Walk a shell lane from (x, y) in direction d. A shell is centred on the lattice, so it straddles
 * the two cells on either side of its centre line. Returns the first cell that stops it (or none
 * within `maxSteps` lattice steps).
 */
function firstBlock(w: TankWorld, x: number, y: number, d: Dir, maxSteps = 30): { x: number; y: number; cx: number; cy: number; terrain: Terrain; steps: number } | undefined {
  const c = w.cell;
  const sx = Math.round(x / c) * c;
  const sy = Math.round(y / c) * c;
  for (let k = 1; k <= maxSteps; k++) {
    // Centre after k steps; the shell then enters the cell on the far side of that line.
    const px = sx + DIR_DX[d] * c * k;
    const py = sy + DIR_DY[d] * c * k;
    let cells: Array<[number, number]>;
    if (DIR_DX[d] === 0) {
      const cy = DIR_DY[d] > 0 ? py / c : py / c - 1;
      cells = [[px / c - 1, cy], [px / c, cy]];
    } else {
      const cx = DIR_DX[d] > 0 ? px / c : px / c - 1;
      cells = [[cx, py / c - 1], [cx, py / c]];
    }
    for (const [cx, cy] of cells) {
      const t = terrainAt(w, cx, cy);
      if (stopsShell(t)) return { x: px, y: py, cx, cy, terrain: t, steps: k };
    }
  }
  return undefined;
}

/** Is `b` inside the lane a shell from (x, y) travelling `d` would sweep, and ahead of it? Returns lattice steps to its body edge. */
function inLane(x: number, y: number, d: Dir, b: { x: number; y: number }, halfWidth = 11, alongMin = 0): number | undefined {
  const along = (b.x - x) * DIR_DX[d] + (b.y - y) * DIR_DY[d];
  const perp = Math.abs((b.x - x) * DIR_DY[d]) + Math.abs((b.y - y) * DIR_DX[d]);
  if (perp >= halfWidth || along <= alongMin) return undefined;
  return Math.max(0, along - 8);
}

/** Open lane between a shooter at (x, y) facing d and a target: no shell-stopping cell before the target's body. */
function laneOpen(w: TankWorld, x: number, y: number, d: Dir, target: { x: number; y: number }): boolean {
  const dist = inLane(x, y, d, target);
  if (dist === undefined) return false;
  const block = firstBlock(w, x, y, d, Math.ceil(dist / w.cell) + 1);
  return !block || block.steps * w.cell > dist;
}

/** Cells of the base wall: bricks around the eagle that must never be shot from our side. */
function isGuardCell(w: TankWorld, cx: number, cy: number): boolean {
  const xs = w.eagle.cells.map((c) => c[0]);
  const ys = w.eagle.cells.map((c) => c[1]);
  return cx >= Math.min(...xs) - 1 && cx <= Math.max(...xs) + 1 && cy >= Math.min(...ys) - 1 && cy <= Math.max(...ys) + 1;
}

/**
 * May we fire from (x, y) in direction d? Not when the first thing the shell would hit is the base
 * or its wall (unless an enemy stands within `closeSteps` on that lane: then the shell hits it first
 * and the base is about to be shot anyway), and not when the partner is in the lane before any enemy.
 */
function shotSafe(w: TankWorld, x: number, y: number, d: Dir, me: TankObs, partner: TankObs | undefined, closeSteps = 8): boolean {
  const block = firstBlock(w, x, y, d);
  if (block) {
    const onBase = block.terrain === "eagle" || block.terrain === "eagleDestroyed" || (block.terrain === "brick" && isGuardCell(w, block.cx, block.cy));
    if (onBase) {
      const enemyClose = w.tanks.some((t) => !t.player && t.alive && !t.spawning && t.slot !== me.slot && (inLane(x, y, d, t) ?? 99) <= closeSteps * w.cell && (inLane(x, y, d, t) ?? 99) < block.steps * w.cell);
      if (!enemyClose) return false;
    }
  }
  if (partner?.alive) {
    const pd = inLane(x, y, d, partner);
    if (pd !== undefined) {
      const firstEnemy = Math.min(...w.tanks.filter((t) => !t.player && t.alive && t.slot !== me.slot).map((t) => inLane(x, y, d, t) ?? 999));
      if (pd < firstEnemy && (!block || pd < block.steps * w.cell)) return false;
    }
  }
  return true;
}

// ───────────────────────── path finding ─────────────────────────

interface Bfs {
  dist: Map<number, number>;
  parent: Map<number, number>;
  key: (x: number, y: number) => number;
  start: { x: number; y: number };
}

function bfs(w: TankWorld, me: TankObs, maxSteps = 40): Bfs {
  const key = (x: number, y: number) => (y << 8) | x;
  const start = { x: snap8(me.x), y: snap8(me.y) };
  const dist = new Map<number, number>();
  const parent = new Map<number, number>();
  const queue: Array<[number, number]> = [[start.x, start.y]];
  dist.set(key(start.x, start.y), 0);
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    const d0 = dist.get(key(x, y))!;
    if (d0 >= maxSteps) continue;
    for (const d of DIRS) {
      const nx = x + DIR_DX[d] * 8;
      const ny = y + DIR_DY[d] * 8;
      const k = key(nx, ny);
      if (dist.has(k)) continue;
      if (!canStand(w, nx, ny, me.slot)) continue;
      dist.set(k, d0 + 1);
      parent.set(k, key(x, y));
      queue.push([nx, ny]);
    }
  }
  return { dist, parent, key, start };
}

/** First lattice point to head for on the way to (x, y), or undefined when unreachable. */
function firstStep(b: Bfs, x: number, y: number): { x: number; y: number } | undefined {
  let k = b.key(x, y);
  if (!b.dist.has(k)) return undefined;
  const startKey = b.key(b.start.x, b.start.y);
  if (k === startKey) return { x, y };
  while (b.parent.get(k) !== startKey) k = b.parent.get(k)!;
  return { x: k & 0xff, y: k >> 8 };
}

// ───────────────────────── decisions ─────────────────────────

interface Ctx {
  game: GameProfile;
  w: TankWorld;
  me: TankObs;
  partner: TankObs | undefined;
  mem: TankMemory;
  now: number;
  fire: Button;
  /** Our own shell in flight → we cannot fire until it lands. */
  shellOut: boolean;
}

function facingOf(ctx: Ctx, t: TankObs): Dir | undefined {
  if (t.dir !== -1) return t.dir;
  return ctx.mem.lastDir.get(t.slot);
}

const perpendicular = (a: Dir, b: Dir): boolean => DIR_DX[a] * DIR_DX[b] + DIR_DY[a] * DIR_DY[b] === 0;

/** Hold a direction (moves us a little) and remember the facing. */
function move(ctx: Ctx, d: Dir, reason: string, fire = false): Action {
  ctx.mem.facing = d;
  const b = BUTTON[d];
  return { hold: [b], turbo: fire ? [ctx.fire] : [], tag: fire ? `${b}+${ctx.fire}` : b, reason };
}

/**
 * Face a direction without driving into it: one tick of the direction when needed, then fire
 * standing. Never fires along a lane that ends in the base (or through the partner): then it only
 * turns and holds, whatever the caller wanted.
 */
function aimFire(ctx: Ctx, d: Dir, reason: string): Action {
  const safe = shotSafe(ctx.w, snap8(ctx.me.x), snap8(ctx.me.y), d, ctx.me, ctx.partner);
  if (ctx.mem.facing !== d) return move(ctx, d, `${reason} (turning)`, safe);
  if (!safe) return { hold: [], turbo: [], tag: "hold", reason: `${reason} — but the base/partner is down that lane, holding fire` };
  ctx.mem.lastFireAt = ctx.now;
  return { hold: [], turbo: [ctx.fire], tag: ctx.fire, reason };
}

interface Threat {
  shell: ShellObs;
  /** Pixels to our body edge. */
  dist: number;
  frames: number;
  /** Our centre is on the shell's line: our own shell would meet it. */
  aligned: boolean;
  /** Signed offset of the shell's line from our centre along the perpendicular axis. */
  offset: number;
}

/** Shells heading for us with nothing in between, nearest first. `halfWidth` widens the lane for early warning. */
function incoming(ctx: Ctx, halfWidth = 12): Threat[] {
  const { w, me } = ctx;
  const out: Threat[] = [];
  for (const s of w.shells) {
    if (!s.enemy) continue;
    const dist = inLane(s.x, s.y, s.dir, me, halfWidth);
    if (dist === undefined) continue;
    if (!laneOpen(w, s.x, s.y, s.dir, me)) continue;
    const offset = DIR_DX[s.dir] === 0 ? s.x - me.x : s.y - me.y;
    out.push({ shell: s, dist, frames: dist / Math.max(1, s.speed), aligned: Math.abs(offset) <= 4, offset });
  }
  return out.sort((a, b) => a.frames - b.frames);
}

/**
 * Step sideways out of a lane: a perpendicular direction whose next lattice points are free. With
 * `awayFrom` (the shell's offset from our centre) the side that increases the distance to the
 * shell's line wins; otherwise a preferred direction, otherwise the side with more room.
 */
function sidestep(ctx: Ctx, laneDir: Dir, prefer?: Dir, awayFrom?: number): Dir | undefined {
  const { w, me } = ctx;
  const options: Dir[] = DIR_DX[laneDir] === 0 ? [1, 3] : [0, 2];
  const x = snap8(me.x);
  const y = snap8(me.y);
  const scored = options.map((d) => {
    const one = canStand(w, x + DIR_DX[d] * 8, y + DIR_DY[d] * 8, me.slot);
    const two = one && canStand(w, x + DIR_DX[d] * 16, y + DIR_DY[d] * 16, me.slot);
    let score = two ? 4 : one ? 2 : 0;
    if (score && awayFrom !== undefined && awayFrom !== 0) {
      const sign = DIR_DX[d] + DIR_DY[d]; // +1 for right/down, -1 for left/up
      if (Math.sign(awayFrom) === -sign) score += 3; // moving away from the shell's line
      else score -= 3;
    }
    if (score && prefer === d) score += 1;
    // Do not step into another enemy's open lane if it can be helped.
    for (const o of w.tanks) {
      if (o.player || !o.alive || o.spawning) continue;
      const f = facingOf(ctx, o);
      const p = { x: x + DIR_DX[d] * 16, y: y + DIR_DY[d] * 16 };
      if (f !== undefined && inLane(o.x, o.y, f, p, 12) !== undefined && laneOpen(w, o.x, o.y, f, p)) score -= 2;
    }
    return { d, score };
  });
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.d : undefined;
}

/** 1. Survive an incoming shell. */
function survive(ctx: Ctx): Action | undefined {
  const { me, mem, now, w } = ctx;
  if (me.spawning || !me.alive) return undefined;
  const threats = incoming(ctx);
  // A sidestep in progress continues until the shell is clearly missed or gone.
  if (mem.dodge && now < mem.dodge.until) {
    const s = w.shells.find((k) => k.slot === mem.dodge!.shellSlot && k.dir === mem.dodge!.shellDir);
    const still = s && inLane(s.x, s.y, s.dir, me, 18) !== undefined;
    if (still && canStand(w, snap8(me.x) + DIR_DX[mem.dodge.dir] * 8, snap8(me.y) + DIR_DY[mem.dodge.dir] * 8, me.slot)) return move(ctx, mem.dodge.dir, `still clearing the lane of shell #${s!.slot}`);
    mem.dodge = undefined;
  } else mem.dodge = undefined;
  if (!threats.length) return undefined;
  const t = threats[0];
  const facingIt = mem.facing === opposite(t.shell.dir);
  const why = `shell incoming from ${["below", "the right", "above", "the left"][t.shell.dir]} (${t.dist}px, ${t.frames.toFixed(0)}f)`;
  // Shoot it down: we face it (or can turn in one tick) and have a shell available.
  if (t.aligned && !ctx.shellOut) {
    if (facingIt) return aimFire(ctx, opposite(t.shell.dir), `${why} → shoot it down`);
    if (t.frames > 2 * w.framesPerTick) return aimFire(ctx, opposite(t.shell.dir), `${why} → turn and shoot it down`);
  }
  // Step out of the lane when there is time: 16 px at player speed (8 px when merely clipped) plus two ticks of latency.
  const need = t.aligned ? 16 : Math.max(4, 14 - Math.abs(t.offset));
  const framesToMove = need / w.speeds.player + 2 * w.framesPerTick;
  const escape = sidestep(ctx, t.shell.dir, me.dir !== -1 && perpendicular(me.dir, t.shell.dir) ? me.dir : undefined, t.offset);
  if (escape !== undefined && (t.frames >= framesToMove || ctx.shellOut || !t.aligned)) {
    mem.dodge = { dir: escape, shellSlot: t.shell.slot, shellDir: t.shell.dir, until: now + 900 };
    return move(ctx, escape, `${why} → step ${BUTTON[escape].toLowerCase()} out of the lane`);
  }
  // No way out: face it and keep firing; the next shell may still meet it.
  return aimFire(ctx, opposite(t.shell.dir), `${why} → no way out, face it and fire`);
}

/**
 * 2. An enemy that faces us down an open lane will fire: fire first. An enemy close by in our lane
 * counts whatever way it faces (a standing tank's facing is unknown and it turns in one frame): at
 * point-blank range its shell arrives between two observations, so never linger there.
 */
function duel(ctx: Ctx): Action | undefined {
  const { w, me, partner, mem, now } = ctx;
  if (!me.alive) return undefined;
  // A sidestep out of an enemy's lane continues until we are clear of that lane.
  if (mem.evade && now < mem.evade.until) {
    const e = w.tanks.find((k) => k.slot === mem.evade!.slot && k.alive);
    const still = e && inLane(e.x, e.y, mem.evade.laneDir, me, 18) !== undefined;
    if (still && canStand(w, snap8(me.x) + DIR_DX[mem.evade.dir] * 8, snap8(me.y) + DIR_DY[mem.evade.dir] * 8, me.slot)) return move(ctx, mem.evade.dir, `still leaving the lane of enemy #${e!.slot}`);
    mem.evade = undefined;
  } else mem.evade = undefined;
  let best: { t: TankObs; dist: number; d: Dir; facing: boolean } | undefined;
  let back: { t: TankObs; dist: number; d: Dir } | undefined;
  for (const t of w.tanks) {
    if (t.player || !t.alive || t.spawning || t.frozen) continue;
    // Direction from the enemy toward us along the lane we share (if any).
    const towardUs: Dir | undefined = DIRS.find((d) => inLane(t.x, t.y, d, me, 12) !== undefined);
    if (towardUs === undefined) continue;
    const dist = inLane(t.x, t.y, towardUs, me, 12)!;
    if (dist > 160) continue;
    if (!laneOpen(w, t.x, t.y, towardUs, me)) continue;
    const f = facingOf(ctx, t);
    if (f !== undefined && f !== towardUs) {
      // Facing away: no threat right now, but a free shot in the back when it is close.
      if (dist <= 64 && (!back || dist < back.dist)) back = { t, dist, d: opposite(towardUs) };
      continue;
    }
    const facing = f === towardUs || (f === undefined && dist <= 64);
    if (!facing && dist > 48) continue;
    if (!best || dist < best.dist) best = { t, dist, d: opposite(towardUs), facing };
  }
  if (!best) {
    if (!back || ctx.shellOut) return undefined;
    const d = back.d;
    const aligned = Math.abs(DIR_DX[d] === 0 ? back.t.x - me.x : back.t.y - me.y) <= 4;
    if (aligned && shotSafe(w, snap8(me.x), snap8(me.y), d, me, partner)) return aimFire(ctx, d, `enemy #${back.t.slot} at ${back.dist}px facing away → shoot it in the back`);
    return undefined;
  }
  const d = best.d;
  const why = `enemy #${best.t.slot} ${best.facing ? "facing us" : "next to us"} at ${best.dist}px`;
  const aligned = Math.abs(DIR_DX[d] === 0 ? best.t.x - me.x : best.t.y - me.y) <= 4;
  // Point-blank and not yet facing it: a turn loses the race, a sidestep may not.
  const escape = sidestep(ctx, opposite(d));
  const leave = (reason: string): Action => {
    mem.evade = { dir: escape!, slot: best!.t.slot, laneDir: opposite(d), until: now + 800 };
    return move(ctx, escape!, reason);
  };
  if (best.dist <= 16 && mem.facing !== d && escape !== undefined) return leave(`${why} → too close to turn, leave its lane`);
  if (!ctx.shellOut && aligned && shotSafe(w, snap8(me.x), snap8(me.y), d, me, partner)) return aimFire(ctx, d, `${why} → fire first`);
  if (escape !== undefined) return leave(`${why} → leave its lane`);
  return aimFire(ctx, d, `${why} → cannot leave, fire`);
}

interface Candidate {
  x: number;
  y: number;
  d: Dir;
  target: TankObs;
  score: number;
}

/** 4. Firing positions: lattice points with an open lane onto an enemy, scored by path length and risk. */
function firingCandidates(ctx: Ctx, b: Bfs, intent: TankIntent | "auto"): Candidate[] {
  const { w, me, partner } = ctx;
  const out: Candidate[] = [];
  const humanNear = (t: TankObs) => (partner?.alive ? Math.abs(t.x - partner.x) + Math.abs(t.y - partner.y) : 999);
  const eagleNear = (t: TankObs) => Math.abs(t.x - w.eagle.x) + Math.abs(t.y - w.eagle.y);
  // Emergency: an enemy within reach of the base makes everything else irrelevant.
  const live = w.tanks.filter((t) => !t.player && t.alive && !t.spawning);
  const closest = Math.min(999, ...live.map(eagleNear));
  const emergency = closest < 112;
  for (const t of live) {
    if (emergency && eagleNear(t) > closest + 32) continue;
    let targetBonus = 0;
    // Enemies near the base come first: one shell on the eagle ends the game for both players.
    if (eagleNear(t) < 96) targetBonus -= intent === "defend_base" ? 20 : 14;
    else if (eagleNear(t) < 160) targetBonus -= intent === "defend_base" ? 10 : 6;
    if (intent === "support_partner" && humanNear(t) < 96) targetBonus -= 10;
    // A moving enemy sits between lattice points: anchor on the point it is heading for.
    const ax = snap8(t.x);
    const ay = snap8(t.y);
    for (const d of DIRS) {
      // Points at direction d from the enemy; from there we shoot opposite(d). Closer than 4 steps
      // (32 px) is point-blank: its shell would land between two observations.
      for (let k = 4; k <= 16; k++) {
        const px = ax + DIR_DX[d] * 8 * k;
        const py = ay + DIR_DY[d] * 8 * k;
        if (!inField(w, px, py)) break;
        const block = firstBlock(w, ax, ay, d, k);
        if (block && block.steps < k) break; // lane closed beyond this point
        const dist = b.dist.get(b.key(px, py));
        if (dist === undefined) continue;
        const shootDir = opposite(d);
        if (!shotSafe(w, px, py, shootDir, me, partner)) continue;
        // Never plan to stand next to another enemy (point-blank range).
        if (w.tanks.some((o) => !o.player && o.alive && o.slot !== t.slot && Math.abs(o.x - px) < 32 && Math.abs(o.y - py) < 32)) continue;
        // Stay in reach of the base: the further from the eagle, the less a position is worth.
        const baseDist = Math.abs(px - w.eagle.x) + Math.abs(py - w.eagle.y);
        const fromBase = baseDist / 24 + (baseDist > 176 && intent !== "engage" && intent !== "support_partner" ? 8 : 0);
        let score = dist + Math.max(0, 6 - k) * 2 + Math.max(0, k - 8) * 0.5 + targetBonus + (intent === "engage" ? fromBase * 0.5 : fromBase);
        // Risk: standing where another enemy faces us.
        for (const o of w.tanks) {
          if (o.player || !o.alive || o.slot === t.slot) continue;
          const f = facingOf(ctx, o);
          if (f !== undefined && inLane(o.x, o.y, f, { x: px, y: py }, 12) !== undefined && laneOpen(w, o.x, o.y, f, { x: px, y: py })) score += 6;
        }
        // Flank: the enemy is not facing this lane.
        const f = facingOf(ctx, t);
        if (f !== undefined && f !== d) score -= 2;
        if (intent === "evade" && f === d) score += 8;
        out.push({ x: px, y: py, d: shootDir, target: t, score });
      }
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

/** Drive toward a lattice point along the BFS tree; fire on the way only at a safe, aligned enemy. */
function driveTo(ctx: Ctx, b: Bfs, x: number, y: number, reason: string): Action | undefined {
  const { me, mem, now } = ctx;
  const step = firstStep(b, x, y);
  if (!step) return undefined;
  let d: Dir;
  if (Math.abs(step.x - me.x) > 1) d = step.x > me.x ? 3 : 1;
  else if (Math.abs(step.y - me.y) > 1) d = step.y > me.y ? 2 : 0;
  else return undefined; // already there
  // Do not step into the lane of a shell that is about to sweep it.
  const stepPoint = { x: snap8(me.x) + DIR_DX[d] * 8, y: snap8(me.y) + DIR_DY[d] * 8 };
  // (a shell level with us, or just past, still clips the body as we move into its lane)
  const sweeping = ctx.w.shells.find((s) => {
    if (!s.enemy) return false;
    const dist = inLane(s.x, s.y, s.dir, stepPoint, 12, -12);
    if (dist === undefined || dist >= 72) return false;
    return dist < 16 || laneOpen(ctx.w, s.x, s.y, s.dir, stepPoint);
  });
  if (sweeping) {
    const fireOk = !ctx.shellOut && shotSafe(ctx.w, snap8(me.x), snap8(me.y), mem.facing, me, ctx.partner) && ctx.w.tanks.some((t) => !t.player && t.alive && !t.spawning && laneOpen(ctx.w, snap8(me.x), snap8(me.y), mem.facing, t));
    return { hold: [], turbo: fireOk ? [ctx.fire] : [], tag: "wait", reason: `${reason} — a shell is crossing ahead, wait` };
  }
  // Blocked (another tank in the way): detour sideways for a moment.
  if (mem.detour && now < mem.detour.until) return move(ctx, mem.detour.dir, `${reason} — detour`);
  if (mem.lastPos.x === me.x && mem.lastPos.y === me.y && now - mem.lastPos.at > 700 && mem.facing === d) {
    const alt = sidestep(ctx, d);
    if (alt !== undefined) {
      mem.detour = { dir: alt, until: now + 450 };
      return move(ctx, alt, `${reason} — blocked, detour ${BUTTON[alt].toLowerCase()}`);
    }
  }
  const opportunistic = ctx.w.tanks.some((t) => !t.player && t.alive && !t.spawning && laneOpen(ctx.w, snap8(me.x), snap8(me.y), d, t) && shotSafe(ctx.w, snap8(me.x), snap8(me.y), d, me, ctx.partner));
  return move(ctx, d, reason, opportunistic && !ctx.shellOut);
}

/** Main entry: the action for this tick. `intent` is the strategic bias from Jev / the coach. */
export function tankDecide(game: GameProfile, obs: Observation, mem: TankMemory, now: number, intent: TankIntent | "auto"): Action & { urgent: boolean } {
  const w = obs.tank!;
  const t = game.tank!;
  const mySlot = t.tanks.playerSlots[(game.players.ai - 1) as 0 | 1];
  const partnerSlot = t.tanks.playerSlots[(game.players.human - 1) as 0 | 1];
  const me = w.tanks.find((k) => k.slot === mySlot);
  const partner = w.tanks.find((k) => k.slot === partnerSlot);
  const idle = (reason: string): Action & { urgent: boolean } => ({ hold: [], turbo: [], tag: "idle", reason, urgent: false });
  // Remember facings of everything that moved.
  for (const k of w.tanks) if (k.dir !== -1) mem.lastDir.set(k.slot, k.dir);
  if (!me || !me.alive || w.paused) {
    mem.plan = undefined;
    return idle(w.paused ? "paused" : "waiting to respawn");
  }
  if (mem.lastPos.x !== me.x || mem.lastPos.y !== me.y) mem.lastPos = { x: me.x, y: me.y, at: now };
  const fire = game.buttons.fire as Button;
  const shellOut = w.shells.some((s) => s.slot === mySlot || s.slot === t.tanks.count + mySlot);
  const ctx: Ctx = { game, w, me, partner, mem, now, fire, shellOut };

  const urgent = survive(ctx) ?? duel(ctx);
  if (urgent) return { ...urgent, urgent: true };

  const b = bfs(w, me);
  const enemies = w.tanks.filter((k) => !k.player && k.alive);

  // 5. Power-up: worth a detour when it is near or the intent says so (and nothing shoots at us).
  if (w.item) {
    const ix = snap8(w.item.x);
    const iy = snap8(w.item.y);
    const dist = b.dist.get(b.key(ix, iy));
    const want = intent === "collect_item" ? 40 : enemies.length === 0 ? 40 : 14;
    if (dist !== undefined && dist <= want) {
      const a = driveTo(ctx, b, ix, iy, `power-up ${dist * 8}px away → collect`);
      if (a) return { ...a, urgent: false };
    }
  }

  // 4. Attack from the best firing position.
  if (intent !== "hold_fire") {
    const cands = firingCandidates(ctx, b, intent);
    let pick = cands[0];
    // Hysteresis: keep the current plan while it is still among the good ones.
    if (mem.plan?.kind === "fire" && now - mem.plan.since < 2500) {
      const same = cands.find((c) => c.x === mem.plan!.x && c.y === mem.plan!.y && c.target.slot === mem.plan!.slot);
      if (same && pick && same.score <= pick.score + 3) pick = same;
    }
    if (pick) {
      if (!mem.plan || mem.plan.kind !== "fire" || mem.plan.x !== pick.x || mem.plan.y !== pick.y || mem.plan.slot !== pick.target.slot) mem.plan = { kind: "fire", x: pick.x, y: pick.y, slot: pick.target.slot, since: now };
      const here = Math.abs(me.x - pick.x) <= 2 && Math.abs(me.y - pick.y) <= 2;
      if (here) {
        const aligned = Math.abs(DIR_DX[pick.d] === 0 ? pick.target.x - me.x : pick.target.y - me.y) <= 6;
        if (aligned && laneOpen(w, snap8(me.x), snap8(me.y), pick.d, pick.target)) return { ...aimFire(ctx, pick.d, `enemy #${pick.target.slot} in the lane → fire`), urgent: false };
        return { ...aimFire(ctx, pick.d, `waiting for enemy #${pick.target.slot} to cross the lane`), urgent: false };
      }
      const a = driveTo(ctx, b, pick.x, pick.y, `to a firing position on enemy #${pick.target.slot} (${(b.dist.get(b.key(pick.x, pick.y)) ?? 0) * 8}px)`);
      if (a) return { ...a, urgent: false };
    } else if (enemies.length) {
      // Nothing reachable: dig toward the most urgent enemy through bricks (never toward the base).
      // Urgent = closest to the base when one is near it, else closest to us.
      const eagleDist = (e: TankObs) => Math.abs(e.x - w.eagle.x) + Math.abs(e.y - w.eagle.y);
      const byBase = [...enemies].sort((p, q) => eagleDist(p) - eagleDist(q))[0];
      const near = eagleDist(byBase) < 112 ? byBase : enemies.map((e) => ({ e, d: Math.abs(e.x - me.x) + Math.abs(e.y - me.y) })).sort((p, q) => p.d - q.d)[0].e;
      const dx = near.x - me.x;
      const dy = near.y - me.y;
      const order: Dir[] = Math.abs(dx) >= Math.abs(dy) ? [dx > 0 ? 3 : 1, dy > 0 ? 2 : 0] : [dy > 0 ? 2 : 0, dx > 0 ? 3 : 1];
      for (const d of order) {
        const block = firstBlock(w, snap8(me.x), snap8(me.y), d, 6);
        if (block && block.terrain === "brick" && shotSafe(w, snap8(me.x), snap8(me.y), d, me, partner)) {
          mem.plan = { kind: "dig", x: block.x, y: block.y, since: now };
          return { ...aimFire(ctx, d, `no open lane → dig ${BUTTON[d].toLowerCase()} toward enemy #${near.slot}`), urgent: false };
        }
        if (!block && canStand(w, snap8(me.x) + DIR_DX[d] * 8, snap8(me.y) + DIR_DY[d] * 8, me.slot)) return { ...move(ctx, d, `closing on enemy #${near.slot}`), urgent: false };
      }
    }
  }

  // 3/6. Hold a post between the enemies and the base, facing the enemies' side.
  const post = { x: snap8(w.eagle.x + (mySlot === t.tanks.playerSlots[0] ? -32 : 32)), y: snap8(w.eagle.y - 32) };
  const facingEnemy: Dir = enemies.length ? (Math.abs(enemies[0].x - me.x) > Math.abs(enemies[0].y - me.y) ? (enemies[0].x > me.x ? 3 : 1) : enemies[0].y > me.y ? 2 : 0) : 0;
  if (intent !== "hold_fire" && (Math.abs(me.x - post.x) > 2 || Math.abs(me.y - post.y) > 2) && b.dist.has(b.key(post.x, post.y))) {
    const a = driveTo(ctx, b, post.x, post.y, "back to the guard post");
    if (a) return { ...a, urgent: false };
  }
  if (mem.facing !== facingEnemy) return { ...move(ctx, facingEnemy, "holding, facing the enemies"), urgent: false };
  return idle(enemies.length ? "holding position" : "waiting for the next wave");
}

/** Debugging aid (used by the offline simulator): the arena as text plus the current firing candidates. */
export function tankDebug(game: GameProfile, obs: Observation, mem: TankMemory): string {
  const w = obs.tank!;
  const t = game.tank!;
  const mySlot = t.tanks.playerSlots[(game.players.ai - 1) as 0 | 1];
  const me = w.tanks.find((k) => k.slot === mySlot);
  const lines: string[] = [];
  const c0 = w.field.x0 / w.cell;
  const c1 = w.field.x1 / w.cell;
  for (let cy = w.field.y0 / w.cell; cy < w.field.y1 / w.cell; cy++) {
    let s = "";
    for (let cx = c0; cx < c1; cx++) {
      const tank = w.tanks.find((k) => k.alive && Math.abs(k.x - (cx * 8 + 4)) < 8 && Math.abs(k.y - (cy * 8 + 4)) < 8);
      const shell = w.shells.find((k) => Math.abs(k.x - (cx * 8 + 4)) < 4 && Math.abs(k.y - (cy * 8 + 4)) < 4);
      if (tank) s += tank.player ? (tank.slot === mySlot ? "A" : "H") : String(tank.slot);
      else if (shell) s += "*";
      else {
        const ter = w.terrainOf(w.cells[cy * w.stride + cx]);
        s += ter === "empty" ? "." : ter === "brick" ? "#" : ter === "steel" ? "S" : ter === "water" ? "~" : ter === "trees" ? "t" : ter === "eagle" ? "E" : ter === "eagleDestroyed" ? "x" : "?";
      }
    }
    lines.push(s);
  }
  if (me) {
    const fire = game.buttons.fire as Button;
    const ctx: Ctx = { game, w, me, partner: undefined, mem, now: 0, fire, shellOut: false };
    const b = bfs(w, me);
    const cands = firingCandidates(ctx, b, "auto").slice(0, 6);
    lines.push(`buddy (${me.x},${me.y}) reachable=${b.dist.size} candidates=${cands.length}: ${cands.map((c) => `(${c.x},${c.y})→#${c.target.slot} ${"ULDR"[c.d]} score ${c.score.toFixed(1)}`).join(" ")}`);
  }
  return lines.join("\n");
}

/** Compact arena summary for Jev / the coach. */
export function tankSummary(obs: Observation, game: GameProfile): Record<string, unknown> {
  const w = obs.tank!;
  const t = game.tank!;
  const mySlot = t.tanks.playerSlots[(game.players.ai - 1) as 0 | 1];
  const me = w.tanks.find((k) => k.slot === mySlot);
  const rel = (p: { x: number; y: number }) => (me ? { dx: p.x - me.x, dy: p.y - me.y } : { dx: 0, dy: 0 });
  const dirName = (d: Dir | -1 | undefined) => (d === undefined || d < 0 ? "still" : ["up", "left", "down", "right"][d]);
  return {
    buddy: me ? { x: me.x, y: me.y, alive: me.alive, shield_seconds: w.shield[(game.players.ai - 1) as 0 | 1], facing: dirName(me.dir) } : { alive: false },
    enemies: w.tanks
      .filter((k) => !k.player && k.alive)
      .map((k) => ({ ...rel(k), moving: dirName(k.dir), spawning: k.spawning, distance_to_base: Math.abs(k.x - w.eagle.x) + Math.abs(k.y - w.eagle.y) }))
      .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)))
      .slice(0, 6),
    enemy_shells: w.shells.filter((s) => s.enemy).map((s) => ({ ...rel(s), heading: dirName(s.dir) })),
    enemies_left_to_spawn: w.enemiesLeft,
    base: { ...rel(w.eagle), alive: w.eagle.alive },
    item: w.item ? { ...rel(w.item), type: ["helmet", "clock", "shovel", "star", "grenade", "tank"][w.item.type] ?? w.item.type } : "none",
  };
}
