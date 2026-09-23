importScripts("/vendor/jsnes.min.js");
let simulator;
const ready = import("./vendor/ai/rollout.js");
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      simulator = new jsnes.NES({ onFrame() {}, onAudioSample: null, emulateSound: false });
      simulator.loadROM(data.rom);
      self.postMessage({ type: "ready" });
      return;
    }
    if (!simulator) return;
    const { forecastPlans } = await ready;
    const start = performance.now();
    const rows = forecastPlans(simulator, data.input);
    self.postMessage({ type: "forecast", frame: data.input.frame, level: data.input.observation.level, lives: data.input.observation.ai.lives, rows, elapsedMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error) });
  }
};
