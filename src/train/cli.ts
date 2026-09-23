import { getGame, playableGames, reloadGames, type GameProfile } from "../games/registry.js";
import { getConfig } from "../config.js";
import { runEpisode, type EpisodeReport } from "./harness.js";
import { describe, learn, loadLearned, loadReports, saveLearned, saveReport } from "./learn.js";
import { loadLedger, recordEval, reflectReport } from "./reflect.js";
import fs from "node:fs";
import path from "node:path";
import { deathsByReach, pairedDifference, teamMetrics } from "./metrics.js";

/**
 * `jev-fc-buddy train <run|learn|sweep|show> [--game id] [--episodes N] [--seed N] [--duo] [--jev] [--frames N] [--level N] [-v]`
 *
 *   run    play N episodes alone (or with the scripted partner, --duo), save the reports, print a summary
 *          --level N starts on level N+1 (RAM poke); --invincible --explore maps a level with a random-jump runner
 *          (falls still count, so pits and platforms fill in without the buddy having to survive the enemies)
 *   learn  fold every saved report into games/<id>/learned.json (pits, kill zones, platforms)
 *   sweep  --param name=v1,v2,...: play N episodes per value, print the table; --apply writes the best one
 *   eval   fixed-seed solo + duo evaluation (default seed 7000, 12 each) recorded in the ledger; --tag names the candidate
 *   reflect  write a markdown report of the latest reports' deaths (grouped by place, with trails) for the next change
 *   show   print what learned.json knows
 */

function getConfigDataDir(): string {
  return getConfig().dataDir;
}

function opt(args: string[], k: string): string | undefined {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
}

function pick(args: string[]): GameProfile {
  const id = opt(args, "--game");
  const g = id ? getGame(id) : playableGames().find((x) => (x.genre ?? "run-and-gun") === "run-and-gun") ?? playableGames()[0];
  if (!g) throw new Error(id ? `unknown game ${id}` : "no playable game (put a ROM in roms/)");
  return g;
}

export function summarize(reports: EpisodeReport[]): { deaths: number; distance: number; perKpx: number; progress: number; level: number; byCause: Record<string, number> } {
  const deaths = reports.reduce((n, r) => n + r.deaths.length, 0);
  const distance = reports.reduce((n, r) => n + r.distance, 0);
  const byCause: Record<string, number> = {};
  for (const r of reports) for (const d of r.deaths) byCause[d.cause] = (byCause[d.cause] ?? 0) + 1;
  return {
    deaths,
    distance,
    perKpx: distance > 0 ? (deaths / distance) * 1000 : deaths,
    progress: Math.round(reports.reduce((n, r) => n + r.progress, 0) / Math.max(1, reports.length)),
    level: Math.max(...reports.map((r) => r.level)),
    byCause,
  };
}

function line(r: EpisodeReport): string {
  const causes = r.deaths.map((d) => `${d.cause[0]}@${d.levelX}`).join(" ");
  return `seed ${String(r.seed).padStart(3)}  level ${r.level + 1}${r.levelsCleared ? `(+${r.levelsCleared})` : ""}  progress ${String(r.progress).padStart(5)}  distance ${String(r.distance).padStart(5)}  deaths ${r.deaths.length}  [${causes}]${r.stuckAt !== undefined ? `  stuck@${r.stuckAt}` : ""}  ${(r.wallMs / 1000).toFixed(1)}s`;
}

async function play(game: GameProfile, args: string[], seeds: number[], quiet = false): Promise<EpisodeReport[]> {
  const mode = args.includes("--duo") ? "duo" : "solo";
  const jev = args.includes("--jev");
  const maxFrames = Number(opt(args, "--frames") ?? 60 * 240);
  const verbose = args.includes("-v");
  const level = Number(opt(args, "--level") ?? 0);
  const invincible = args.includes("--invincible");
  const explore = args.includes("--explore");
  const out: EpisodeReport[] = [];
  for (const seed of seeds) {
    const r = await runEpisode({ game, mode, seed, jev, maxFrames, verbose, level, invincible, explore });
    out.push(r);
    if (!quiet) process.stdout.write(line(r) + "\n");
  }
  return out;
}

export async function trainCli(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "run";
  const args = rest.slice(1);
  const game = pick(args);
  const episodes = Number(opt(args, "--episodes") ?? 5);
  const seed0 = Number(opt(args, "--seed") ?? Date.now() % 1000);
  const seeds = Array.from({ length: episodes }, (_, i) => seed0 + i);
  switch (sub) {
    case "compare": {
      const n = Number(opt(args, "--episodes") ?? 12);
      const start = Number(opt(args, "--seed") ?? 7000);
      const evalSeeds = Array.from({ length: n }, (_, i) => start + i);
      if (!getConfig().typesafe.apiKey) throw new Error("Jev comparison requires a configured key; refusing to silently run two reflex baselines");
      const off: EpisodeReport[] = [], on: EpisodeReport[] = [];
      const baseArgs = args.filter(a => a !== "--jev" && a !== "--duo");
      for (const duo of [false, true]) {
        const modeArgs = duo ? [...baseArgs, "--duo"] : baseArgs;
        for (const seed of evalSeeds) {
          process.stdout.write(`pair ${duo ? "duo" : "solo"} seed ${seed}: reflex\n`);
          const [baseline] = await play(game, modeArgs, [seed]);
          saveReport(game, baseline!); off.push(baseline!);
          process.stdout.write(`pair ${duo ? "duo" : "solo"} seed ${seed}: Jev\n`);
          const [model] = await play(game, [...modeArgs, "--jev"], [seed]);
          saveReport(game, model!); on.push(model!);
        }
      }
      const result = { at: new Date().toISOString(), seed: start, episodesPerMode: n, maxFrames: Number(opt(args, "--frames") ?? 14400), off: teamMetrics(off), on: teamMetrics(on), difference: pairedDifference(off, on), decisions: on.map(r => ({ seed: r.seed, mode: r.mode, ...r.decisions })) };
      const file = path.join(getConfigDataDir(), "train", `${game.id}-comparison-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      process.stdout.write(JSON.stringify(result, null, 2) + `\n(saved to ${file})\n`);
      return;
    }
    case "run": {
      const rounds = Number(opt(args, "--rounds") ?? 1);
      let g = game;
      for (let round = 0; round < rounds; round++) {
        process.stdout.write(`${g.title}: ${episodes} episode(s), ${args.includes("--duo") ? "with the scripted partner" : "alone"}, ${args.includes("--jev") ? "Jev on (real time)" : "reflex only (fast)"}${rounds > 1 ? ` — round ${round + 1}/${rounds}` : ""}\n`);
        const roundSeeds = seeds.map((x) => x + round * 100);
        const reports = await play(g, args, roundSeeds);
        for (const r of reports) saveReport(g, r);
        const s = summarize(reports);
        process.stdout.write(`total: ${s.deaths} deaths over ${s.distance}px → ${s.perKpx.toFixed(2)} deaths per 1000px; mean progress ${s.progress}; causes ${JSON.stringify(s.byCause)}\n\n`);
        if (args.includes("--learn") || rounds > 1) {
          const learned = learn(g, loadReports(g));
          saveLearned(g, learned);
          if (round === rounds - 1) process.stdout.write(`learned.json updated from ${learned.episodes} episodes:\n${describe(learned)}\n`);
          reloadGames();
          g = getGame(g.id) ?? g;
        }
      }
      return;
    }
    case "learn": {
      const reports = loadReports(game);
      if (!reports.length) throw new Error("no reports yet: run `train run` first");
      const learned = learn(game, reports);
      saveLearned(game, learned);
      process.stdout.write(`learned.json written from ${reports.length} episodes:\n${describe(learned)}\n`);
      return;
    }
    case "eval": {
      const n = Number(opt(args, "--episodes") ?? 12);
      const seed = Number(opt(args, "--seed") ?? 7000);
      const evalSeeds = Array.from({ length: n }, (_, i) => seed + i);
      const tag = opt(args, "--tag") ?? "untagged";
      process.stdout.write(`eval "${tag}": ${n} solo + ${n} duo episodes, seeds ${seed}..${seed + n - 1}\n`);
      const solo = await play(game, args.filter((a) => a !== "--duo"), evalSeeds, true);
      const duo = await play(game, [...args, "--duo"], evalSeeds, true);
      for (const r of [...solo, ...duo]) saveReport(game, r);
      const { entry, best } = recordEval(game, tag, seed, n, solo, duo);
      const fmt = (e: { deaths: number; perKpx: number; progress: number }) => `${e.deaths} deaths, ${e.perKpx.toFixed(2)}/1000px, progress ${e.progress}`;
      process.stdout.write(`solo: ${fmt(entry.solo)}\nduo:  ${fmt(entry.duo)}\nscore ${entry.score.toFixed(3)} (${entry.sha})${best ? ` vs best ${best.score.toFixed(3)} (${best.tag}, ${best.sha})` : ""} → ${entry.accepted ? "ACCEPTED" : "worse, keep the previous policy"}\n`);
      if (best?.team) {
        // Where the deaths are relative to the best accepted run's reach: beyond it means ground the reference never played.
        const reach = (label: string, reports: EpisodeReport[], ref: { level: number; progress: number }) => {
          const split = deathsByReach(reports, ref);
          return `${label}: ${split.within} deaths within the reference reach (stage ${ref.level}, x≤${Math.round(ref.progress)}), ${split.beyond} beyond it`;
        };
        process.stdout.write(`${reach("solo", solo, best.team.solo)}\n${reach("duo", duo, best.team.duo)}\n`);
      }
      for (const why of entry.rejectedBy ?? []) process.stdout.write(`  regression: ${why}\n`);
      return;
    }
    case "ledger": {
      for (const e of loadLedger(game)) {
        process.stdout.write(`${e.at.slice(0, 16)} ${e.sha.padEnd(9)} ${e.tag.padEnd(28)} solo ${String(e.solo.deaths).padStart(3)} (${e.solo.perKpx.toFixed(2)}) reach ${String(e.solo.progress).padStart(4)}  duo ${String(e.duo.deaths).padStart(3)} (${e.duo.perKpx.toFixed(2)}) reach ${String(e.duo.progress).padStart(4)}  score ${e.score.toFixed(3)} ${e.accepted ? "✓" : "✗"}\n`);
        for (const why of e.rejectedBy ?? []) process.stdout.write(`${" ".repeat(17)}✗ ${why}\n`);
      }
      return;
    }
    case "reflect": {
      const last = Number(opt(args, "--last") ?? 24);
      const reports = loadReports(game).slice(-last);
      if (!reports.length) throw new Error("no reports yet");
      const md = reflectReport(game, reports);
      const file = path.join(getConfigDataDir(), "train", `${game.id}-reflect-${new Date().toISOString().slice(0, 16).replace(/[:]/g, "-")}.md`);
      fs.writeFileSync(file, md);
      process.stdout.write(md + `\n(saved to ${file})\n`);
      return;
    }
    case "show": {
      process.stdout.write(describe(loadLearned(game)) + "\n");
      return;
    }
    case "sweep": {
      const spec = opt(args, "--param");
      if (!spec || !spec.includes("=")) throw new Error("usage: train sweep --param dodgeDistance=48,64,80,96 [--episodes N] [--apply]");
      const [name, list] = spec.split("=") as [string, string];
      const values = list.split(",").map(Number);
      const rows: Array<{ value: number; perKpx: number; distance: number; deaths: number }> = [];
      for (const value of values) {
        const g: GameProfile = { ...game, reflex: { ...game.reflex, [name]: value } };
        const reports = await play(g, args, seeds, true);
        const s = summarize(reports);
        rows.push({ value, perKpx: s.perKpx, distance: s.distance, deaths: s.deaths });
        process.stdout.write(`${name}=${String(value).padEnd(5)} deaths ${String(s.deaths).padStart(3)}  distance ${String(s.distance).padStart(6)}  ${s.perKpx.toFixed(2)} deaths/1000px\n`);
      }
      const best = [...rows].sort((a, b) => a.perKpx - b.perKpx || b.distance - a.distance)[0]!;
      process.stdout.write(`best: ${name}=${best.value}${(game.reflex as Record<string, unknown>)[name] === best.value ? " (unchanged)" : ""}\n`);
      if (args.includes("--apply")) {
        const learned = loadLearned(game);
        (learned.params as Record<string, number>)[name] = best.value;
        saveLearned(game, learned);
        reloadGames();
        process.stdout.write(`applied to learned.json\n`);
      }
      return;
    }
    default:
      throw new Error(`unknown train command ${sub}`);
  }
}
