import { getGame, playableGames, reloadGames, type GameProfile } from "../games/registry.js";
import { runEpisode, type EpisodeReport } from "./harness.js";
import { describe, learn, loadLearned, loadReports, saveLearned, saveReport } from "./learn.js";

/**
 * `jev-fc-buddy train <run|learn|sweep|show> [--game id] [--episodes N] [--seed N] [--duo] [--jev] [--frames N] [-v]`
 *
 *   run    play N episodes alone (or with the scripted partner, --duo), save the reports, print a summary
 *   learn  fold every saved report into games/<id>/learned.json (pits, kill zones, platforms)
 *   sweep  --param name=v1,v2,...: play N episodes per value, print the table; --apply writes the best one
 *   show   print what learned.json knows
 */

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
  return `seed ${String(r.seed).padStart(3)}  level ${r.level + 1}  progress ${String(r.progress).padStart(5)}  distance ${String(r.distance).padStart(5)}  deaths ${r.deaths.length}  [${causes}]${r.stuckAt !== undefined ? `  stuck@${r.stuckAt}` : ""}  ${(r.wallMs / 1000).toFixed(1)}s`;
}

async function play(game: GameProfile, args: string[], seeds: number[], quiet = false): Promise<EpisodeReport[]> {
  const mode = args.includes("--duo") ? "duo" : "solo";
  const jev = args.includes("--jev");
  const maxFrames = Number(opt(args, "--frames") ?? 60 * 240);
  const verbose = args.includes("-v");
  const out: EpisodeReport[] = [];
  for (const seed of seeds) {
    const r = await runEpisode({ game, mode, seed, jev, maxFrames, verbose });
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
