#!/usr/bin/env node
// Headless end-to-end check: pretends to be the browser. Runs jsnes in Node, opens a coin-backed
// session against a running server, streams RAM, applies the AI's inputs, and drives player 1
// with a dumb "run right and shoot" script. Prints the ops stream and a summary.
//
//   node scripts/headless-play.mjs [--base http://localhost:8790] [--seconds 60] [--code FC-...] [--game <id>] [--shots dir]
//
// For the tank genre the dummy human wanders (changes direction every few seconds) and fires.
// --shots <dir> writes a PNG of the screen every 10 s (needs data/bc-explore/png.mjs).
import WebSocket from "ws";
import { createRequire } from "node:module";
const jsnes = createRequire(import.meta.url)("jsnes"); // UMD bundle: require() works for both jsnes 1.x and 2.x

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const base = opt("--base", "http://localhost:8790");
const seconds = Number(opt("--seconds", "60"));
const gameId = opt("--game");
const shotsDir = opt("--shots");
let code = opt("--code");
let writePng;
if (shotsDir) ({ writePng } = await import("../data/bc-explore/png.mjs"));

async function api(path, body) {
  const res = await fetch(base + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

if (!code) code = (await api("/api/admin/codes", { coins: 1, note: "headless-play" })).code;
const { games } = await api("/api/games");
const game = gameId ? games.find((g) => g.id === gameId) : games[0];
if (!game) throw new Error(gameId ? `game ${gameId} is not playable (games: ${games.map((g) => g.id).join(", ")})` : "no playable game (put a ROM in roms/)");
const tank = game.genre === "tank";
const s = await api("/api/sessions", { code, gameId: game.id, lang: "zh-CN" });
console.log(`session ${s.sessionId} on ${game.id}, coins left ${s.remaining}, expires ${s.expiresAt}`);

const romRes = await fetch(`${base}/api/games/${game.id}/rom?token=${s.token}`);
const bytes = new Uint8Array(await romRes.arrayBuffer());
let bin = "";
for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);

let lastFb;
const nes = new jsnes.NES({ onFrame(fb) { lastFb = fb; }, onAudioSample: null });
nes.loadROM(bin);

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?token=${s.token}`);
const held = new Set();
const turbo = new Set();
let actC = 0;
const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
const stats = { acts: 0, ops: 0, says: 0, phases: [], buddyDeaths: 0, partnerDeaths: 0 };
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "act") {
    stats.acts++;
    if (m.controller && m.controller !== actC) {
      if (actC) for (let b = 0; b < 8; b++) nes.buttonUp(actC, b);
      actC = m.controller;
    }
    held.clear();
    turbo.clear();
    for (const b of m.hold) held.add(BTN[b]);
    for (const b of m.turbo) turbo.add(BTN[b]);
  } else if (m.type === "op") {
    stats.ops++;
    if (m.src === "system" && m.text.startsWith("buddy down")) stats.buddyDeaths++;
    if (m.src === "system" && m.text.startsWith("partner down")) stats.partnerDeaths++;
    console.log(`  [${m.src}] ${m.text}${m.detail?.top ? `  (${m.detail.top})` : ""}`);
  } else if (m.type === "say") {
    stats.says++;
    console.log(`  💬 ${m.text}`);
  } else if (m.type === "status") {
    if (stats.phases.at(-1) !== m.phase) stats.phases.push(m.phase);
    console.log(`  [status] jev=${m.jev} coach=${m.coach} phase=${m.phase}`);
  } else if (m.type === "needShot") {
    ws.send(JSON.stringify({ type: "shot", jpeg: "" }));
  } else if (m.type === "expired") {
    console.log(`  [expired] ${m.reason}`);
  }
});
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", lang: "zh-CN" }));

let frame = 0;
const humanC = game.players.human;
const aiC = game.players.ai;
const ranges = game.ramRanges;
const started = Date.now();
const mem = nes.cpu.mem;

let tick = 0;
const timer = setInterval(() => {
  // 60 fps at a 24 Hz timer: 2 or 3 frames per tick
  const burst = tick++ % 2 ? 3 : 2;
  for (let k = 0; k < burst; k++) {
    for (let b = 0; b < 8; b++) {
      let down = held.has(b);
      if (turbo.has(b)) down = (frame >> 2) & 1;
      if (down) nes.buttonDown(actC || aiC, b);
      else nes.buttonUp(actC || aiC, b);
    }
    // "human": after 6 s hold RIGHT + turbo B; tap START once the game runs.
    // Tank games: wander (a new direction every ~3 s) and fire.
    const t = (Date.now() - started) / 1000;
    if (t > 6 && !tank) {
      nes.buttonDown(humanC, BTN.RIGHT);
      if ((frame >> 2) & 1) nes.buttonDown(humanC, BTN.B);
      else nes.buttonUp(humanC, BTN.B);
      if (frame % 240 === 0) nes.buttonDown(humanC, BTN.A);
      else nes.buttonUp(humanC, BTN.A);
    } else if (t > 6) {
      const dirs = [BTN.UP, BTN.LEFT, BTN.DOWN, BTN.RIGHT];
      const slot = Math.floor(frame / 180) % 7;
      const pick = dirs[slot % 4];
      for (const d of dirs) if (d !== pick) nes.buttonUp(humanC, d);
      if (slot < 4) nes.buttonDown(humanC, pick);
      // Fire only when facing up: a wandering dummy must not shell its own base at the bottom.
      if (((frame >> 3) & 1) && slot % 4 === 0) nes.buttonDown(humanC, BTN.B);
      else nes.buttonUp(humanC, BTN.B);
    }
    nes.frame();
    frame++;
    if (writePng && frame % 600 === 0 && lastFb) writePng(`${shotsDir}/headless-${String(frame / 600).padStart(3, "0")}.png`, lastFb);
  }
  let total = 0;
  for (const [a, b] of ranges) total += b - a;
  const out = Buffer.alloc(total);
  let o = 0;
  for (const [a, b] of ranges) {
    out.set(mem.slice(a, b) /* jsnes 1.x: plain Array, 2.x: Uint8Array */, o);
    o += b - a;
  }
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "obs", ram: out.toString("base64") }));
}, 1000 / 24);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
ws.close();
console.log(`\nsummary: frames=${frame} acts=${stats.acts} ops=${stats.ops} says=${stats.says} buddyDeaths=${stats.buddyDeaths} partnerDeaths=${stats.partnerDeaths} phases=${stats.phases.join("→")}`);
if (tank) console.log(`ram: title=${mem[0x50]} phase=${mem[0x6a]} cursor=${mem[0x83]} stage=${mem[0x85]} p1=(${mem[0x90]},${mem[0x98]}) p2=(${mem[0x91]},${mem[0x99]}) lives=${mem[0x51]}/${mem[0x52]} enemiesLeft=${mem[0x7f]}`);
else console.log(`ram: gameRoutine=${mem[0x18]} levelRoutine=${mem[0x2c]} playerMode=${mem[0x22]} p1=(${mem[0x334]},${mem[0x31a]}) p2=(${mem[0x335]},${mem[0x31b]}) lives=${mem[0x32]}/${mem[0x33]} state=${mem[0x90]}/${mem[0x91]}`);
process.exit(0);
