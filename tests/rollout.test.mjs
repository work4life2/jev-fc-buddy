import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import { playableGames, romPath } from "../dist/games/registry.js";
import { observe } from "../dist/ai/observe.js";
import { GameController } from "../dist/ai/control.js";
import { forecastPlans } from "../dist/ai/rollout.js";

test("emulator forecasts are repeatable and do not mutate the live state or another branch", () => {
  const { NES } = createRequire(import.meta.url)("jsnes");
  const profile = playableGames().find(g => (g.genre ?? "run-and-gun") === "run-and-gun");
  const game = { ...profile, players: { ai: 1, human: 2 } };
  const rom = fs.readFileSync(romPath(game), "binary");
  const live = new NES({ onFrame() {}, onAudioSample: null, emulateSound: false });
  live.loadROM(rom);
  const snapshot = () => Uint8Array.from(game.ramRanges.flatMap(([a,b]) => live.cpu.mem.slice(a,b)));
  for (let i = 0; i < 400; i++) live.frame();
  live.buttonDown(1, 3);
  for (let i = 0; i < 6; i++) live.frame();
  live.buttonUp(1, 3);
  let obs;
  for (let i = 0; i < 1600; i++) { live.frame(); obs = observe(game, snapshot(), obs); if (obs.phase === "playing" && obs.ai.alive && obs.ai.onGround) break; }
  assert.equal(obs.phase, "playing");
  const controller = new GameController(game);
  controller.step(obs);
  const input = { game, snapshot: structuredClone(live.toJSON()), controllers: [1,2].map(c => [...live.controllers[c].state]), observation: obs, memory: controller.mem, candidates: controller.candidates, frame: 1000 };
  const initial = JSON.stringify(input);
  const simulator = new NES({ onFrame() {}, onAudioSample: null, emulateSound: false });
  simulator.loadROM(rom);
  const a = forecastPlans(simulator, input, 15);
  const b = forecastPlans(simulator, input, 15);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), initial);
  assert.deepEqual(live.toJSON(), input.snapshot);
  assert.equal(a.length, input.candidates.length);
  assert.ok(a.every(r => r.scenarios === 2));
});
