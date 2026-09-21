import fs from "node:fs";
import * as jsnes from "jsnes";
const bytes = fs.readFileSync("/home/zk/code/jev-fc-buddy/roms/contra.nes");
let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
const nes = new jsnes.NES({ onFrame() {}, onAudioSample: null });
nes.loadROM(bin);
const m = nes.cpu.mem;
const seen = new Map();
let f = 0;
const press = (c, b, frames) => { nes.buttonDown(c, b); for (let i = 0; i < frames; i++) { nes.frame(); f++; } nes.buttonUp(c, b); };
// title: select 2P, start
for (let i = 0; i < 300; i++) { nes.frame(); f++; }
while (m[0x22] !== 1) { press(1, 2, 4); for (let i = 0; i < 30; i++) { nes.frame(); f++; } }
press(1, 3, 6);
for (let i = 0; i < 30000; i++) {
  // both players run right and jump periodically; P1 also fires
  nes.buttonDown(1, 7); nes.buttonDown(2, 7);
  if ((f >> 2) & 1) { nes.buttonDown(1, 1); nes.buttonDown(2, 1); } else { nes.buttonUp(1, 1); nes.buttonUp(2, 1); }
  if (f % 180 === 0) { nes.buttonDown(1, 0); nes.buttonDown(2, 0); } else { nes.buttonUp(1, 0); nes.buttonUp(2, 0); }
  nes.frame(); f++;
  const level = m[0x30], scroll = m[0x64] * 256 + m[0x65];
  for (let s = 0; s < 16; s++) {
    if (m[0x4b8 + s] === 0) continue;
    const t = m[0x528 + s];
    if (t === 0x12 || t === 0x11 || t === 0x10) {
      const lx = scroll + m[0x33e + s];
      const key = `${level}:${t.toString(16)}:${Math.round(lx / 16) * 16}`;
      if (!seen.has(key)) seen.set(key, { level, type: t.toString(16), lx, y: m[0x324 + s], frame: f });
    }
  }
  if (m[0x2c] >= 5 && m[0x2c] <= 7) break;
}
console.log("level", m[0x30], "levelRoutine", m[0x2c], "lives", m[0x32], m[0x33], "p1", m[0x334], m[0x31a], "scroll", m[0x64] * 256 + m[0x65]);
console.log([...seen.values()].sort((a, b) => a.lx - b.lx).map((v) => `${v.level} type${v.type} lx=${v.lx} y=${v.y} f=${v.frame}`).join("\n"));
