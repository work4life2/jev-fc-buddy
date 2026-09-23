import type { GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";

/**
 * Route planning over the learned platform map: which ledge to take next to get to the end of the
 * level. The platforms come from self-play (ground the buddy has stood on, `learned.json`); the
 * hops between them follow the measured jump reach. The result is one concrete next hop ("walk to
 * x, then jump up onto the ledge 32 px above"), which the reflex policy executes and Jev is told.
 */

/** Jump reach, measured in the emulator: 58 px up, ~60 frames, 59 px across on level ground at 1 px/frame. */
export const JUMP = { height: 58, across: 59, fallPxPerFrame: 2.5 };

export type Platform = [number, number, number];

export interface Hop {
  kind: "jump_up" | "jump_forward" | "drop" | "walk";
  /** Level-x where the move is made (the ledge end, or the spot under the ledge above). */
  atX: number;
  /** Direction of the move: +1 toward the level end, -1 back (to get out of a dead end). */
  dir: 1 | -1;
  to: Platform;
  from: Platform;
}

export interface RouteInfo {
  here: Platform;
  next: Hop;
  /** Hops after this one (for Jev's overview). */
  hops: number;
  /** Level-x the route ends at (the furthest known ground). */
  endX: number;
  /** Route cost from here: px to walk plus 40 per hop, backward walking doubled. */
  cost: number;
}

function overlap(a: Platform, b: Platform): number {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

function hopsFrom(platforms: Platform[], i: number, badJumps: Array<[number, number, number, number, number]>, bridges: Array<[number, number]>): Hop[] {
  const A = platforms[i]!;
  const out: Hop[] = [];
  for (let j = 0; j < platforms.length; j++) {
    if (j === i) continue;
    const B = platforms[j]!;
    const dy = B[2] - A[2];
    const bad = (x: number) => badJumps.some((k) => x >= k[0] - 8 && x <= k[1] + 8 && Math.abs(k[2] - A[2]) <= 4 && k[3] === B[2]);
    // Straight up onto a ledge overhead (ledges can be entered from below).
    if (dy < 0 && dy >= -JUMP.height + 6 && overlap(A, B) >= 8) {
      const atX = Math.round((Math.max(A[0], B[0]) + Math.min(A[1], B[1])) / 2);
      if (!bad(atX)) out.push({ kind: "jump_up", atX, dir: 1, to: B, from: A });
    }
    // Same height across a bridge (ground that explodes as it is crossed, never sampled as standing ground): walk.
    if (dy === 0 && B[0] > A[1] && bridges.some(([x1, x2]) => x1 <= A[1] + 16 && x2 >= B[0] - 16)) out.push({ kind: "walk", atX: A[1], dir: 1, to: B, from: A });
    // From either end: drop onto ground that continues below, or jump across to the next ledge.
    // A learned ledge end is known to within one 8 px bucket: take off from inside the last sampled bucket.
    for (const dir of [1, -1] as const) {
      const edgeX = dir > 0 ? A[1] - 8 : A[0] + 8;
      const near = dir > 0 ? B[0] : B[1]; // B's edge facing us
      const far = dir > 0 ? B[1] : B[0];
      if ((dir > 0 ? B[0] <= edgeX && B[1] > edgeX + 16 : B[1] >= edgeX && B[0] < edgeX - 16) && dy > 0 && dy < 120) out.push({ kind: "drop", atX: edgeX, dir, to: B, from: A });
      if ((near - edgeX) * dir >= -8) {
        const gapX = (near - edgeX) * dir;
        const reach = dy <= 0 ? (dy >= -JUMP.height + 6 ? JUMP.across - Math.abs(dy) * 0.5 : -1) : JUMP.across + dy / JUMP.fallPxPerFrame;
        if (reach >= 0 && gapX <= reach && (far - near) * dir > 0 && !bad(edgeX)) out.push({ kind: dy > 0 && gapX <= 0 ? "drop" : "jump_forward", atX: edgeX, dir, to: B, from: A });
      }
    }
  }
  return out;
}

/** The platform the buddy stands on, if the map knows it. */
export function platformAt(platforms: Platform[], x: number, y: number): Platform | undefined {
  return platforms.find(([a, b, py]) => x >= a - 6 && x <= b + 6 && Math.abs(py - y) <= 4);
}

const cache = new WeakMap<object, { level: number; blocked: string; minX: number; platforms: Platform[]; next: Map<Platform, Hop | null>; cost: Map<Platform, number> }>();

/** Key of a hop, for the runtime block list (a hop that ended in a fall this session). */
export function hopKey(h: Hop): string {
  return `${h.from.join(",")}>${h.to.join(",")}`;
}

/** The platform graph of a level, built once per learned map (and per set of blocked hops). */
function graphFor(game: GameProfile, level: number, blocked?: Set<string>, minX = 0): { level: number; blocked: string; minX: number; platforms: Platform[]; next: Map<Platform, Hop | null>; cost: Map<Platform, number> } | undefined {
  const L = game.learned?.levels[String(level)];
  if (!L?.platforms?.length) return undefined;
  const blockedKey = blocked ? [...blocked].sort().join("|") : "";
  let c = cache.get(L);
  if (!c || c.level !== level || c.blocked !== blockedKey || c.minX !== minX) {
    const platforms = (L.platforms as Platform[]).filter(([a, b]) => b - a >= 24 && b >= minX);
    if (!platforms.length) return undefined;
    const badJumps = L.badJumps ?? [];
    const bridges = (game.terrain?.gaps?.[String(level)] ?? []).filter((z) => z.length < 5 || z[4] === "bridge").map((z) => [z[0], z[1]] as [number, number]);
    // Goal: the platform reaching furthest right. BFS backwards from it gives every node's next hop.
    const goal = platforms.reduce((g, p) => (p[1] > g[1] ? p : g), platforms[0]!);
    const hops = platforms.map((_, i) => hopsFrom(platforms, i, badJumps, bridges).filter((h) => h.atX >= minX && !blocked?.has(hopKey(h))));
    // Cheapest route by distance walked (a hop costs a fixed 40 px on top; walking back costs double):
    // Dijkstra backwards from the goal, so every platform knows its next hop.
    const next = new Map<Platform, Hop | null>();
    const cost = new Map<Platform, number>();
    next.set(goal, null);
    cost.set(goal, 0);
    const open = new Set<Platform>([goal]);
    while (open.size) {
      let B: Platform | undefined;
      for (const p of open) if (!B || cost.get(p)! < cost.get(B)!) B = p;
      open.delete(B!);
      platforms.forEach((A, i) => {
        for (const h of hops[i]!) {
          if (h.to !== B) continue;
          const mid = (A[0] + A[1]) / 2;
          const walk = Math.abs(h.atX - mid) * (h.dir < 0 ? 2 : 1);
          const cA = cost.get(B!)! + 40 + walk;
          if (cA < (cost.get(A) ?? Infinity)) {
            cost.set(A, cA);
            next.set(A, h);
            open.add(A);
          }
        }
      });
    }
    c = { level, blocked: blockedKey, minX, platforms, next, cost };
    cache.set(L, c);
  }
  return c;
}

/** Cheapest route from the buddy's platform toward the furthest known ground on this level. */
export function routeAhead(game: GameProfile, obs: Observation, blocked?: Set<string>): RouteInfo | undefined {
  if (obs.levelDirection !== "right") return undefined;
  // A shared screen cannot scroll back: a route through ground behind it is not executable.
  const c = graphFor(game, obs.level, blocked, obs.levelScrollX + 8);
  if (!c) return undefined;
  const here = platformAt(c.platforms, obs.ai.levelX, obs.ai.y);
  if (!here) return undefined;
  const hop = c.next.get(here);
  if (hop === undefined) return undefined; // no known way on from here
  const endX = Math.max(...c.platforms.map((p) => p[1]));
  const cost = c.cost.get(here) ?? Infinity;
  if (hop === null) return { here, next: { kind: "walk", atX: here[1], dir: 1, to: here, from: here }, hops: 0, endX, cost };
  let n = 0;
  for (let p: Hop | null | undefined = c.next.get(hop.to); p; p = c.next.get(p.to)) n++;
  return { here, next: hop, hops: n, endX, cost };
}

/** Platforms on this level that have a way on to the end, with the route cost (px-ish) from each. */
export function routedPlatforms(game: GameProfile, level: number, blocked?: Set<string>): Array<{ platform: Platform; cost: number }> {
  const c = graphFor(game, level, blocked);
  if (!c) return [];
  return c.platforms.filter((p) => c.next.get(p) !== undefined).map((p) => ({ platform: p, cost: c.cost.get(p) ?? Infinity }));
}

/** One sentence for Jev / the ops stream. */
export function describeHop(r: RouteInfo, me: number): string {
  const h = r.next;
  const d = Math.round(h.atX - me);
  const where = Math.abs(d) <= 6 ? "here" : d > 0 ? `${d}px ahead` : `${-d}px back`;
  const back = h.dir < 0 ? " BACK (the way on is behind us)" : "";
  const across = Math.abs(h.dir > 0 ? h.to[0] - h.from[1] : h.from[0] - h.to[1]);
  // The "(dx N, dy M)" tail is what the self-play harness parses to learn which jumps never arrive.
  switch (h.kind) {
    case "jump_up":
      return `jump straight up ${where} onto the ledge ${h.from[2] - h.to[2]}px above (dx 0, dy ${h.to[2] - h.from[2]})`;
    case "jump_forward":
      return `jump${back} from the ledge end ${where} to the next ledge (${across}px across, ${h.to[2] - h.from[2] <= 0 ? `${h.from[2] - h.to[2]}px up` : `${h.to[2] - h.from[2]}px down`}) (dx ${across * h.dir}, dy ${h.to[2] - h.from[2]})`;
    case "drop":
      return `walk${back} off the ledge end ${where}: ground ${h.to[2] - h.from[2]}px below`;
    default:
      return h.to === h.from ? `this ledge runs to the end of the known map (${Math.round(r.endX - me)}px ahead)` : `cross the bridge ${where}`;
  }
}
