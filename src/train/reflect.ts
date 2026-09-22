import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { GameProfile } from "../games/registry.js";
import type { DeathRecord, EpisodeReport } from "./harness.js";
import { loadLearned, reportsDir } from "./learn.js";
import { summarize } from "./cli.js";

/**
 * The reflection side of the loop (after JevHarness): fixed-seed evaluations go into a ledger so
 * every candidate policy is compared on the same episodes, and `reflect` turns the latest traces
 * into a report a proposer (a person or an LLM session) can act on: where the buddy dies, what it
 * was doing, what the learned map says there.
 */

export interface LedgerEntry {
  at: string;
  sha: string;
  tag: string;
  seed: number;
  episodes: number;
  solo: { deaths: number; distance: number; perKpx: number; progress: number };
  duo: { deaths: number; distance: number; perKpx: number; progress: number };
  /** Lower is better: deaths per 1000px, solo and duo averaged, duo weighted double (the product is co-op). */
  score: number;
  accepted?: boolean;
}

export function ledgerPath(game: GameProfile): string {
  return path.join(reportsDir(game), "..", `${game.id}-ledger.json`);
}

export function loadLedger(game: GameProfile): LedgerEntry[] {
  const f = ledgerPath(game);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as LedgerEntry[]) : [];
}

export function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain -- src games", { encoding: "utf8" }).trim() ? "+" : "");
  } catch {
    return "unknown";
  }
}

export function recordEval(game: GameProfile, tag: string, seed: number, episodes: number, solo: EpisodeReport[], duo: EpisodeReport[]): { entry: LedgerEntry; best?: LedgerEntry } {
  const s = summarize(solo);
  const d = summarize(duo);
  const ledger = loadLedger(game);
  const best = ledger.filter((e) => e.accepted).sort((a, b) => a.score - b.score)[0];
  const entry: LedgerEntry = {
    at: new Date().toISOString(),
    sha: gitSha(),
    tag,
    seed,
    episodes,
    solo: { deaths: s.deaths, distance: s.distance, perKpx: s.perKpx, progress: s.progress },
    duo: { deaths: d.deaths, distance: d.distance, perKpx: d.perKpx, progress: d.progress },
    score: (s.perKpx + 2 * d.perKpx) / 3,
  };
  entry.accepted = !best || entry.score <= best.score;
  ledger.push(entry);
  fs.writeFileSync(ledgerPath(game), JSON.stringify(ledger, null, 1) + "\n");
  return { entry, best };
}

function place(d: DeathRecord): string {
  return `${d.cause} @ x≈${Math.round(d.levelX / 50) * 50} y≈${Math.round(d.y / 10) * 10}`;
}

/** Markdown: the latest `last` reports grouped by death place, with what the buddy was doing. */
export function reflectReport(game: GameProfile, reports: EpisodeReport[]): string {
  const learned = loadLearned(game);
  const lines: string[] = [`# Reflection: ${game.title} (${reports.length} episodes, ${gitSha()})`, ""];
  for (const mode of ["solo", "duo"] as const) {
    const rs = reports.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    const s = summarize(rs);
    lines.push(`## ${mode}: ${s.deaths} deaths over ${s.distance}px = ${s.perKpx.toFixed(2)} per 1000px, mean progress ${s.progress}, stuck in ${rs.filter((r) => r.stuckAt !== undefined).length}/${rs.length} episodes`, "");
    const groups = new Map<string, DeathRecord[]>();
    for (const r of rs) for (const d of r.deaths) (groups.get(place(d)) ?? groups.set(place(d), []).get(place(d))!).push(d);
    for (const [k, ds] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const d = ds[0]!;
      const still = Math.round(ds.reduce((n, x) => n + x.stillFrames, 0) / ds.length);
      lines.push(`### ${ds.length}× ${k}`);
      lines.push(`- killer: ${d.killer ? `${d.killer.category}#${d.killer.type.toString(16)} at dx ${d.killer.dx}, dy ${d.killer.dy}, v ${d.killer.vx}/${d.killer.vy}` : "none in view"}${d.shooter ? `; nearest shooter #${d.shooter.type.toString(16)} at dx ${d.shooter.dx}, dy ${d.shooter.dy}` : ""}${d.fallFromX !== undefined ? `; fell from (${d.fallFromX}, ${d.fallFromY})` : ""}; ${d.onGround ? "on ground" : "in the air"}; still for ${still} frames on average`);
      lines.push(`- last actions: ${d.trail.slice(-4).join(" → ")}`);
      const lvl = learned.levels[String(d.level)];
      const zone = lvl?.killZones.find((z) => d.levelX >= z.x1 - 16 && d.levelX <= z.x2 + 16 && d.y >= z.yMin - 24 && d.y <= z.yMax + 24);
      const pit = lvl?.pits.find((p) => d.levelX >= p[0] - 16 && d.levelX <= p[1] + 16);
      if (zone || pit) lines.push(`- learned map: ${zone ? `kill zone ×${zone.count} (${zone.cause} from ${zone.from}) ` : ""}${pit ? `pit ${pit[0]}–${pit[1]} (${pit[4]}, ${pit[5]} falls)` : ""}`);
      lines.push("");
    }
    const stuck = rs.filter((r) => r.stuckAt !== undefined).map((r) => r.stuckAt!);
    if (stuck.length) lines.push(`Stuck at: ${stuck.sort((a, b) => a - b).join(", ")}`, "");
  }
  lines.push("## How to use this", "", "For each group: is the last action the wrong rule, a right rule with wrong numbers, or a missing fact in the observation? Change one thing in src/ai/policy.ts (or the Jev criteria in src/ai/criteria.ts), then `train eval --tag <what>`; keep the change only if the ledger score does not get worse.", "");
  return lines.join("\n");
}
