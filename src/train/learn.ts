import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import type { GameProfile, Learned, LearnedLevel, KillZone } from "../games/registry.js";
import type { DeathRecord, EpisodeReport } from "./harness.js";

/**
 * Turns self-play episodes into `games/<id>/learned.json`: where the buddy falls (pits), where it
 * gets shot or run over and from which direction (kill zones), and which ground it has stood on
 * (platforms). The reflex policy and Jev's state both read that file, so what the buddy learns
 * alone is what it plays with next to a human.
 */

export function learnedPath(game: GameProfile): string {
  return path.join(getConfig().gamesDir, game.id, "learned.json");
}

export function loadLearned(game: GameProfile): Learned {
  const file = learnedPath(game);
  if (!fs.existsSync(file)) return { version: 1, updatedAt: "", episodes: 0, levels: {}, params: {} };
  return JSON.parse(fs.readFileSync(file, "utf8")) as Learned;
}

export function saveLearned(game: GameProfile, learned: Learned): void {
  learned.updatedAt = new Date().toISOString();
  fs.writeFileSync(learnedPath(game), JSON.stringify(learned, null, 1) + "\n");
}

export function reportsDir(game: GameProfile): string {
  const dir = path.join(getConfig().dataDir, "train", game.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveReport(game: GameProfile, r: EpisodeReport): string {
  const file = path.join(reportsDir(game), `${new Date().toISOString().replace(/[:.]/g, "-")}-${r.mode}-s${r.seed}.json`);
  fs.writeFileSync(file, JSON.stringify(r));
  return file;
}

export function loadReports(game: GameProfile): EpisodeReport[] {
  const dir = reportsDir(game);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EpisodeReport);
}

/** Where the killer stood relative to the buddy. */
function fromOf(d: DeathRecord): KillZone["from"] {
  const src = d.shooter ?? d.killer;
  if (!src) return "level";
  if (src.dy < -28) return "above";
  if (src.dy > 28) return "below";
  return src.dx < 0 ? "behind" : "level";
}

function adviceFor(z: KillZone): string {
  switch (z.cause) {
    case "shot":
      if (z.from === "above") return z.still > 20 ? "a shooter above kills anyone who stops here: keep moving through, never stand or wait" : "diagonal shots from above land here: lie prone the moment one is close, keep moving otherwise";
      if (z.from === "below") return "shots come up from below here: never stand over the shooter, step aside";
      if (z.from === "behind") return "bullets arrive from behind here: face back and shoot, or lie prone";
      return "bullets at body height here: lie prone when one comes, do not jump into it";
    case "contact":
      return z.from === "above" ? "enemies drop in from above here: step back from under them" : "enemies run into the buddy here: shoot them at range, keep 40px, never walk into them";
    default:
      return "the buddy died here repeatedly";
  }
}

/** Merge a sorted list of x intervals (with payload) whose gaps are below `slack`. */
function cluster<T extends { x1: number; x2: number }>(items: T[], slack: number, same: (a: T, b: T) => boolean, merge: (a: T, b: T) => T): T[] {
  const out: T[] = [];
  for (const it of [...items].sort((a, b) => a.x1 - b.x1)) {
    const last = out[out.length - 1];
    if (last && it.x1 <= last.x2 + slack && same(last, it)) out[out.length - 1] = merge(last, it);
    else out.push(it);
  }
  return out;
}

export function learn(game: GameProfile, reports: EpisodeReport[]): Learned {
  const learned = loadLearned(game);
  const levels: Record<string, LearnedLevel> = {};
  const deathsByLevel = new Map<number, DeathRecord[]>();
  for (const r of reports) for (const d of r.deaths) (deathsByLevel.get(d.level) ?? deathsByLevel.set(d.level, []).get(d.level)!).push(d);
  const groundByLevel = new Map<number, Map<number, Set<number>>>();
  for (const r of reports)
    for (const [lvl, buckets] of Object.entries(r.ground)) {
      const g = groundByLevel.get(Number(lvl)) ?? groundByLevel.set(Number(lvl), new Map()).get(Number(lvl))!;
      for (const [x, ys] of Object.entries(buckets)) for (const y of ys) (g.get(Number(x)) ?? g.set(Number(x), new Set()).get(Number(x))!).add(y);
    }
  const allLevels = new Set([...deathsByLevel.keys(), ...groundByLevel.keys()]);
  for (const lvl of allLevels) {
    const deaths = deathsByLevel.get(lvl) ?? [];
    // Pits: from the last solid ground to where the fall ended.
    const falls = deaths
      .filter((d) => d.cause === "fall")
      // The zone is the edge the buddy stepped off (a fall from a high ledge drifts far before it lands).
      .map((d) => ({ x1: (d.fallFromX ?? d.levelX) - 4, x2: Math.min(d.levelX + 8, (d.fallFromX ?? d.levelX) + 24), y1: d.fallFromY ?? d.y, y2: 240, count: 1, jumped: d.trail.slice(-3).some((t) => t.startsWith("A")) ? 1 : 0 }))
      .map((f) => (f.x2 <= f.x1 ? { ...f, x2: f.x1 + 16 } : f));
    const pits = cluster(
      falls,
      8,
      () => true,
      (a, b) => ({ x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), y1: Math.min(a.y1, b.y1), y2: 240, count: a.count + b.count, jumped: a.jumped + b.jumped }),
    ).filter((p) => p.count >= 2);
    // Kill zones: same cause and direction within 48 px and 40 px of height.
    const hits = deaths
      .filter((d) => d.cause === "shot" || d.cause === "contact")
      .map((d) => ({ x1: d.levelX - 16, x2: d.levelX + 16, yMin: d.y - 12, yMax: d.y + 12, cause: d.cause as KillZone["cause"], from: fromOf(d), count: 1, still: d.stillFrames, advice: "" }));
    const killZones = cluster(
      hits,
      48,
      (a, b) => a.cause === b.cause && a.from === b.from && Math.abs((a.yMin + a.yMax) / 2 - (b.yMin + b.yMax) / 2) < 40,
      (a, b) => ({ ...a, x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), yMin: Math.min(a.yMin, b.yMin), yMax: Math.max(a.yMax, b.yMax), count: a.count + b.count, still: (a.still * a.count + b.still * b.count) / (a.count + b.count) }),
    )
      .filter((z) => z.count >= 2)
      .map((z) => ({ ...z, still: Math.round(z.still), advice: adviceFor(z) }));
    // Platforms: runs of 8 px buckets that share a ground y.
    const g = groundByLevel.get(lvl) ?? new Map<number, Set<number>>();
    const byY = new Map<number, number[]>();
    for (const [x, ys] of g) for (const y of ys) (byY.get(y) ?? byY.set(y, []).get(y)!).push(x);
    const platforms: Array<[number, number, number]> = [];
    for (const [y, xs] of byY) {
      xs.sort((a, b) => a - b);
      let start = xs[0]!;
      let end = xs[0]!;
      for (const x of xs.slice(1)) {
        if (x <= end + 16) end = x;
        else {
          platforms.push([start, end + 8, y]);
          start = end = x;
        }
      }
      platforms.push([start, end + 8, y]);
    }
    platforms.sort((a, b) => a[0] - b[0]);
    // Jumps toward a platform that did not land on it (a cliff face, a ledge that cannot be entered): remembered per edge.
    // A death in the air says nothing about the ledge; and a ledge that was reached at least once is reachable.
    const targeted = reports.flatMap((r) => r.jumps ?? []).filter((j) => j.level === lvl && j.targetY !== undefined && !j.died);
    const reached = targeted.filter((j) => j.ok);
    const failed = targeted
      .filter((j) => !j.ok && !reached.some((s) => Math.abs(s.x - j.x) <= 32 && Math.abs(s.y - j.y) <= 4 && s.targetY === j.targetY))
      .map((j) => ({ x1: j.x - 16, x2: j.x + 16, y: j.y, targetY: j.targetY!, count: 1 }));
    const badJumps = cluster(
      failed,
      16,
      (a, b) => Math.abs(a.y - b.y) <= 4 && a.targetY === b.targetY,
      (a, b) => ({ x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), y: a.y, targetY: a.targetY, count: a.count + b.count }),
    ).filter((j) => j.count >= 2);
    levels[String(lvl)] = {
      deaths: deaths.length,
      // The zone applies from the height the buddy fell from down to the bottom of the screen.
      pits: pits.map((p) => {
        const farSide = platforms.some(([a, , py]) => a >= p.x2 - 8 && a <= p.x2 + 48 && Math.abs(py - p.y1) <= 24);
        return [p.x1, p.x2, p.y1 - 24, 240, farSide ? "hop" : "pit", p.count];
      }),
      killZones,
      platforms: platforms.filter(([a, b]) => b - a >= 16),
      badJumps: badJumps.map((j) => [j.x1, j.x2, j.y, j.targetY, j.count]),
    };
  }
  learned.levels = levels;
  learned.episodes = reports.length;
  return learned;
}

/** One line per level for the terminal. */
export function describe(learned: Learned): string {
  const lines: string[] = [];
  for (const [lvl, L] of Object.entries(learned.levels)) {
    lines.push(`level ${Number(lvl) + 1}: ${L.deaths} deaths, ${L.pits.length} pits, ${L.killZones.length} kill zones, ${L.platforms.length} platforms`);
    for (const p of L.pits) lines.push(`  pit  x ${p[0]}–${p[1]} y ${p[2]}–${p[3]} (${p[4]}, ${p[5]} falls)`);
    for (const j of L.badJumps ?? []) lines.push(`  no-jump x ${j[0]}–${j[1]} from y ${j[2]} to y ${j[3]} (${j[4]} failed)`);
    for (const z of L.killZones) lines.push(`  zone x ${z.x1}–${z.x2} y ${z.yMin}–${z.yMax} ${z.cause} from ${z.from} ×${z.count}, still ${z.still}f: ${z.advice}`);
  }
  if (Object.keys(learned.params).length) lines.push(`params: ${JSON.stringify(learned.params)}`);
  return lines.join("\n");
}
