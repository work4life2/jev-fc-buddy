import type { EpisodeReport } from "./harness.js";

export interface TeamMetrics {
  level: number;
  progress: number;
  cleared: number;
  deaths: number;
  partnerDeaths: number;
  stuck: number;
}

export function teamMetrics(reports: EpisodeReport[]): TeamMetrics {
  const n = Math.max(1, reports.length);
  return {
    level: reports.reduce((s, r) => s + r.level, 0) / n,
    progress: reports.reduce((s, r) => s + r.progress, 0) / n,
    cleared: reports.reduce((s, r) => s + (r.levelsCleared ?? 0), 0) / n,
    deaths: reports.reduce((s, r) => s + r.deaths.length, 0),
    partnerDeaths: reports.reduce((s, r) => s + r.partnerDeaths, 0),
    stuck: reports.filter(r => r.stuckAt !== undefined).length,
  };
}

/** A later stage beats a larger x on an earlier stage; never hide team deaths behind distance. */
export function noRegression(candidate: TeamMetrics, reference: TeamMetrics): boolean {
  return regressions(candidate, reference).length === 0;
}

/** The dimensions on which the candidate is worse than the reference, named so a rejection explains itself. */
export function regressions(candidate: TeamMetrics, reference: TeamMetrics): string[] {
  const out: string[] = [];
  const reachOk = candidate.level > reference.level || (candidate.level === reference.level && candidate.progress >= reference.progress - 16);
  if (!reachOk) out.push(`reach ${candidate.level}/${Math.round(candidate.progress)} < ${reference.level}/${Math.round(reference.progress)}`);
  if (candidate.deaths > reference.deaths) out.push(`deaths ${candidate.deaths} > ${reference.deaths}`);
  if (candidate.partnerDeaths > reference.partnerDeaths) out.push(`partner deaths ${candidate.partnerDeaths} > ${reference.partnerDeaths}`);
  if (candidate.stuck > reference.stuck) out.push(`stuck ${candidate.stuck} > ${reference.stuck}`);
  if (candidate.cleared < reference.cleared) out.push(`cleared ${candidate.cleared} < ${reference.cleared}`);
  return out;
}

/**
 * Deaths split at the reference's mean reach (same stage only). A candidate that gets further than the
 * reference ever did collects deaths in ground the reference never saw; this shows how many of its
 * deaths are those, so "more deaths" can be read as "died further along" or as a real regression.
 */
export function deathsByReach(reports: EpisodeReport[], reference: Pick<TeamMetrics, "level" | "progress">): { within: number; beyond: number } {
  let within = 0, beyond = 0;
  for (const r of reports) for (const d of r.deaths) {
    if (d.level > reference.level || (d.level === reference.level && d.levelX > reference.progress)) beyond++; else within++;
  }
  return { within, beyond };
}

export function pairedDifference(off: EpisodeReport[], on: EpisodeReport[]) {
  const pairs = on.map(r => ({ on: r, off: off.find(b => b.seed === r.seed && b.mode === r.mode) })).filter((p): p is { on: EpisodeReport; off: EpisodeReport } => !!p.off);
  const interval = (values: number[]) => {
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    const margin = n > 1 ? 1.96 * Math.sqrt(variance / n) : null;
    return { mean, approximate95: margin === null ? null : [mean - margin, mean + margin] };
  };
  return {
    pairs: pairs.length,
    teamDeaths: interval(pairs.map(p => p.on.deaths.length + p.on.partnerDeaths - p.off.deaths.length - p.off.partnerDeaths)),
    levelsCleared: interval(pairs.map(p => (p.on.levelsCleared ?? 0) - (p.off.levelsCleared ?? 0))),
    sameLevelProgress: interval(pairs.filter(p => p.on.level === p.off.level).map(p => p.on.progress - p.off.progress)),
    note: "On minus off; normal-approximation intervals are descriptive, not a claim of significance for small or correlated samples.",
  };
}
