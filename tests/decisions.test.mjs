import assert from "node:assert/strict";
import test from "node:test";
import { playableGames } from "../dist/games/registry.js";
import { actionFor, newMemory } from "../dist/ai/policy.js";
import { GameController } from "../dist/ai/control.js";
import { jevState } from "../dist/ai/jev.js";
import { observe } from "../dist/ai/observe.js";
import { tacticValid } from "../dist/ai/tactics.js";
import { BuddyBrain } from "../dist/ai/player.js";
import { routeAhead } from "../dist/ai/route.js";

const profile = playableGames().find(g => (g.genre ?? "run-and-gun") === "run-and-gun");
const game = { ...profile, terrain: undefined, learned: undefined };
function observation() {
  const player = { x: 100, y: 100, state: game.playerState.normal, alive: true, lives: 3, gameOver: false, xVel: 0, onGround: true, motion: "grounded", invincible: false, weapon: 0, levelX: 100 };
  return { game: game.id, frame: 20, phase: "playing", playerMode: 1, level: 0, levelDirection: "right", corridor: false, ai: player, human: { ...player, x: 150, levelX: 150, xVel: 1 }, enemies: [], screen: game.screen, levelScrollX: 0, at: 10000 };
}

test("a cliff stop remains stationary when the human advances", () => {
  const action = actionFor(game, observation(), "hold_fire", newMemory(), 10000);
  assert.deepEqual(action.hold, []);
  assert.deepEqual(action.turbo, [game.buttons.fire]);
});

test("corridor alignment does not reverse to follow a partner", () => {
  const obs = observation();
  obs.corridor = true;
  obs.human.x = 20;
  const action = actionFor(game, obs, "advance_fire", newMemory(), obs.at);
  assert.ok(action.hold.includes("RIGHT"));
  assert.ok(!action.hold.includes("LEFT"));
});

test("a forward escape does not turn into retreat when the partner is behind", () => {
  const obs = observation();
  obs.ai.x = 200; obs.human.x = 30;
  const action = actionFor(game, obs, "advance_fire", newMemory(), obs.at);
  assert.ok(action.hold.includes("RIGHT"));
  assert.ok(!action.hold.includes("LEFT"));
});

test("small gaps retain their jumpable type in model input", () => {
  const state = jevState(observation(), { gap: { dxStart: 10, dxEnd: 42, width: 32, inside: false, partner: "near", kind: "hop" } });
  assert.equal(state.pit_ahead.kind, "hop");
  assert.ok(!state.pit_ahead.note.includes("too wide"));
  assert.ok(!state.pit_ahead.note.includes("explode"));
});

test("old responses cannot acquire a new lifetime on receipt", () => {
  const c = new GameController(game);
  const obs = observation();
  c.step(obs);
  const selection = { tactic: c.candidates.find(t => t.kind === "regroup"), frame: 0, ttlMs: 1800, probability: 0.9 };
  assert.ok(selection.tactic);
  assert.equal(c.accept(selection, obs, 120), false);
  assert.equal(c.accept({ ...selection, ttlMs: -1 }, obs, 0), false);
  assert.equal(c.accept({ ...selection, ttlMs: 800 }, obs, 60), true);
  const later = { ...obs, at: obs.at + 1000 };
  assert.equal(c.step(later).source, "reflex");
});

test("plans are invalidated by a death, even if the player comes back at the same place", () => {
  const c = new GameController(game);
  const obs = observation();
  c.step(obs);
  assert.equal(c.accept({ tactic: c.candidates[1], frame: 0, ttlMs: 1500, probability: 0.9 }, obs, 0), true);
  c.step({ ...obs, at: 10010, ai: { ...obs.ai, alive: false } });
  assert.equal(c.step({ ...obs, at: 10020 }).source, "reflex");
  assert.equal(c.epoch, 2);
});

test("targeted plans finish when a target disappears or its slot is reused elsewhere", () => {
  const c = new GameController(game);
  const obs = observation();
  obs.corridor = true;
  obs.enemies = [{ slot: 2, type: 12, hp: 4, category: "hostile", x: 150, y: 30, vx: 0, vy: 0 }];
  c.step(obs);
  const tactic = c.candidates.find(t => t.kind === "target");
  assert.ok(tactic);
  obs.enemies = [];
  c.step(obs);
  assert.equal(tacticValid(tactic, obs, c.candidates), false);
  obs.enemies = [{ slot: 2, type: 12, hp: 4, category: "hostile", x: 230, y: 30, vx: 0, vy: 0 }];
  c.step(obs);
  assert.equal(tacticValid(tactic, obs, c.candidates), false);
});

function snapshot(values) {
  const mem = new Uint8Array(65536);
  for (const [addr, value] of values) mem[Number(addr)] = value;
  return Uint8Array.from(game.ramRanges.flatMap(([a,b]) => [...mem.slice(a,b)]));
}

test("walking off a ledge is falling, and enemy velocity is frame normalized", () => {
  const r = game.ram;
  const playing = game.phases.playing;
  const base = [[r.gameRoutine, playing.gameRoutine[0]], [r.levelRoutine, playing.levelRoutine[0]], [r.playerState[1], game.playerState.normal], [r.playerX[1],100], [r.playerY[1],100], [r.lives[1],3], [r.frame,20], [r.enemies.routine,1], [r.enemies.type,1], [r.enemies.x,140], [r.enemies.y,80]];
  const first = observe(game, snapshot(base));
  const next = observe(game, snapshot([...base, [r.frame,25], [r.playerY[1],108], [r.enemies.x,130]]), first);
  assert.equal(next.ai.motion, "falling");
  assert.equal(next.ai.onGround, false);
  assert.equal(next.enemies[0].vxPerFrame, -2);
});

test("an in-flight model response is discarded after a death and respawn", async () => {
  const messages = [];
  let resolve, chosen;
  const brain = new BuddyBrain({ game, quiet: true, send: m => messages.push(m), decide: (_g, _o, extra) => new Promise(r => { resolve = r; chosen = extra.candidates[1].id; }) });
  const r = game.ram, playing = game.phases.playing;
  const base = [[r.gameRoutine,playing.gameRoutine[0]],[r.levelRoutine,playing.levelRoutine[0]],[r.playerState[0],game.playerState.normal],[r.playerState[1],game.playerState.normal],[r.playerX[0],150],[r.playerY[0],100],[r.playerX[1],100],[r.playerY[1],100],[r.lives[0],3],[r.lives[1],3],[r.frame,20]];
  brain.onObservation(snapshot(base), 100, 1);
  assert.equal(typeof resolve,"function");
  brain.onObservation(snapshot([...base,[r.playerState[1],game.playerState.dead],[r.frame,23]]),103,2);
  brain.onObservation(snapshot([...base,[r.frame,26]]),106,3);
  resolve({ action:"hold_fire", planId:chosen, probabilities:{[chosen]:1}, confidence:1, usage:{input:1,output:1}, latencyMs:10, model:"test" });
  await brain.settled();
  brain.stop();
  assert.equal(messages.filter(m=>m.type==="plan").length,0);
  assert.equal(brain.diagnostics().rejected,1);
});

test("a route cannot rely on a jump point that scrolled offscreen", () => {
  const obs = observation();
  obs.levelScrollX = 100; obs.ai.levelX = 150; obs.ai.y = 150;
  const mapped = {...game,learned:{version:1,episodes:0,updatedAt:"",params:{},levels:{0:{platforms:[[0,200,150],[0,90,110],[80,220,70]],pits:[],killZones:[],deaths:0}}}};
  assert.equal(routeAhead(mapped,obs),undefined);
});
