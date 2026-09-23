import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { forecastPlans, type Simulation, type RolloutInput } from "../ai/rollout.js";

const { NES } = createRequire(import.meta.url)("jsnes");
const nes = new NES({ onFrame() {}, onAudioSample: null, emulateSound: false });
nes.loadROM(workerData.rom);
parentPort!.on("message", (input: RolloutInput) => {
  try {
    const rows = forecastPlans(nes as Simulation, input);
    parentPort!.postMessage({ frame: input.frame, level: input.observation.level, lives: input.observation.ai.lives, rows });
  } catch {
    parentPort!.postMessage({ error: true });
  }
});
