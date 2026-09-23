import assert from "node:assert/strict";
import test from "node:test";
import { noRegression, regressions, deathsByReach, teamMetrics, pairedDifference } from "../dist/train/metrics.js";

const report = (seed, changes = {}) => ({ seed, mode: "duo", level: 0, progress: 2000, levelsCleared: 0, deaths: [], partnerDeaths: 0, ...changes });

test("reaching a later stage is progress even when its x is smaller", () => {
  const old = teamMetrics([report(1)]);
  const next = teamMetrics([report(1, { level: 1, progress: 100, levelsCleared: 1 })]);
  assert.equal(noRegression(next, old), true);
});

test("extra deaths cannot be hidden by a larger distance", () => {
  const old = teamMetrics([report(1)]);
  assert.equal(noRegression(teamMetrics([report(1, { progress: 3000, deaths: [{}] })]), old), false);
  assert.equal(noRegression(teamMetrics([report(1, { progress: 3000, partnerDeaths: 1 })]), old), false);
});

test("a rejection names the regressed dimensions and splits deaths at the reference reach", () => {
  const old = teamMetrics([report(1, { progress: 2300 })]);
  const next = [report(1, { progress: 3200, deaths: [{ level: 0, levelX: 2100 }, { level: 0, levelX: 3100 }, { level: 0, levelX: 3150 }], partnerDeaths: 1 })];
  assert.deepEqual(regressions(teamMetrics(next), old), ["deaths 3 > 0", "partner deaths 1 > 0"]);
  assert.deepEqual(deathsByReach(next, old), { within: 1, beyond: 2 });
  assert.deepEqual(regressions(old, old), []);
});

test("model comparison pairs by seed and mode, not array position", () => {
  const off = [report(1, { partnerDeaths: 2 }), report(2, { partnerDeaths: 4 })];
  const on = [report(2, { partnerDeaths: 3 }), report(1, { partnerDeaths: 1 })];
  const result = pairedDifference(off, on);
  assert.equal(result.pairs, 2);
  assert.equal(result.teamDeaths.mean, -1);
  assert.deepEqual(result.teamDeaths.approximate95, [-1, -1]);
  assert.equal(pairedDifference(off, [report(5)]).pairs, 0);
});
