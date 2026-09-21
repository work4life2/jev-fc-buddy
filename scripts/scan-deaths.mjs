// Runs one bot along the level (hold RIGHT, fire, jump every 3 s) and prints where it dies.
import fs from "node:fs";
import { createRequire } from "node:module";
const jsnes = createRequire(import.meta.url)("jsnes"); // UMD bundle: require() works for both jsnes 1.x and 2.x
const bytes = fs.readFileSync("roms/contra.nes");
let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
const nes = new jsnes.NES({ onFrame() {}, onAudioSample: null });
nes.loadROM(bin);
const m = nes.cpu.mem;
let f = 0;
const step = () => { nes.frame(); f++; };
for (let i = 0; i < 300; i++) step();
nes.buttonDown(1, 3); for (let i = 0; i < 6; i++) step(); nes.buttonUp(1, 3); // 1P start
let lastState = 1, lastX = 0, lastY = 0, lastLx = 0;
const deaths = [];
for (let i = 0; i < 40000 && deaths.length < 3; i++) {
  nes.buttonDown(1, 7);
  if ((f >> 2) & 1) nes.buttonDown(1, 1); else nes.buttonUp(1, 1);
  if (f % 180 === 0) nes.buttonDown(1, 0); else nes.buttonUp(1, 0);
  step();
  const st = m[0x90];
  if (st === 1) { lastX = m[0x334]; lastY = m[0x31a]; lastLx = m[0x64] * 256 + m[0x65] + lastX; }
  if (lastState === 1 && st === 2) deaths.push({ f, lx: lastLx, x: lastX, y: lastY, lives: m[0x32] });
  lastState = st;
  if (m[0x2c] >= 5 && m[0x2c] <= 7) break;
}
console.log(deaths.map((d) => `death f=${d.f} levelX=${d.lx} x=${d.x} y=${d.y}`).join("\n"));
