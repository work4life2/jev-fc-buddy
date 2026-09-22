import fs from "node:fs";
import { createRequire } from "node:module";
import { BuddyBrain, type BuddyMessage } from "../ai/player.js";
import { observe, parseAddr, type Observation } from "../ai/observe.js";
import { jevEnabled } from "../ai/jev.js";
import { romPath, type GameProfile } from "../games/registry.js";
import type { Button } from "../ai/policy.js";

/**
 * Self-play harness: runs the game in jsnes inside this process, hands every observation to the
 * same BuddyBrain the play server uses, and records what happened. No browser, no WebSocket, no
 * coins. In `solo` mode the buddy is player 1 in a 1-player game (nobody to follow: the pure
 * survival test); in `duo` mode a scripted player 1 runs right and fires, the buddy is player 2.
 *
 * Time is virtual: Date.now() is advanced 1000/60 ms per emulated frame so the brain's timers
 * (jump throttles, commits, prone holds) behave exactly as in real play while the emulator runs as
 * fast as the CPU allows (~10× real time). With Jev on, the loop is paced to real time instead,
 * because the model's answers arrive in wall-clock time.
 */

const jsnes = createRequire(import.meta.url)("jsnes") as { NES: new (o: { onFrame(fb: unknown): void; onAudioSample: null }) => Nes };
interface Nes {
  loadROM(bin: string): void;
  frame(): void;
  buttonDown(c: number, b: number): void;
  buttonUp(c: number, b: number): void;
  cpu: { mem: number[] };
}
const BTN: Record<Button, number> = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };

export type DeathCause = "fall" | "shot" | "contact" | "respawn" | "unknown";

export interface DeathRecord {
  frame: number;
  level: number;
  levelX: number;
  y: number;
  cause: DeathCause;
  /** For a fall: where the buddy last stood on solid ground (level-x, screen-y). */
  fallFromX?: number;
  fallFromY?: number;
  /** Nearest object at death, relative to the buddy. */
  killer?: { category: string; type: number; dx: number; dy: number; vx: number; vy: number };
  /** Where the shooter of a fatal projectile stood, if one was in view. */
  shooter?: { type: number; dx: number; dy: number };
  onGround: boolean;
  /** The buddy's last actions (tag + reason), newest last. */
  trail: string[];
  /** How long (frames) the buddy had been standing still before dying. */
  stillFrames: number;
}

/** A jump the policy took on purpose toward a known platform, and where it actually ended up. */
export interface JumpRecord {
  level: number;
  x: number;
  y: number;
  /** Intended landing height (screen y), when the reason named one. */
  targetY?: number;
  landedX: number;
  landedY: number;
  ok: boolean;
  /** The buddy died in the air: says nothing about whether the ledge can be reached. */
  died?: boolean;
}

export interface EpisodeReport {
  game: string;
  mode: "solo" | "duo";
  seed: number;
  jev: boolean;
  frames: number;
  /** Highest level reached (0-based) and the furthest level-x on it. */
  level: number;
  progress: number;
  /** Sum of level-x gained over the episode (each life's forward progress), the scoring distance. */
  distance: number;
  deaths: DeathRecord[];
  jumps: JumpRecord[];
  partnerDeaths: number;
  /** Ground samples: level → x-bucket (8 px) → set of ground y values seen. */
  ground: Record<string, Record<string, number[]>>;
  actions: Record<string, number>;
  /** The buddy stopped making progress (alive, same level-x for 30 s): where. */
  stuckAt?: number;
  /** Levels finished during the episode. */
  levelsCleared?: number;
  wallMs: number;
}

export interface HarnessOptions {
  game: GameProfile;
  mode: "solo" | "duo";
  seed: number;
  /** Stop after this many emulated frames (default 60 × 240 = 4 minutes of game time). */
  maxFrames?: number;
  /** Ask Jev (real-time pacing). Default: off. */
  jev?: boolean;
  /** Print the ops stream. */
  verbose?: boolean;
  /** Start on this level (0-based) by writing the profile's `level` RAM byte while the game loads. */
  level?: number;
  /** Keep the buddy's invincibility timer up (mapping runs: it still falls into pits). */
  invincible?: boolean;
  /** Explorer: ignore the brain, run forward with turbo fire and jump at seeded random moments, so the ground map fills in. */
  explore?: boolean;
  onFrame?: (nes: { mem: number[] }, frame: number) => void;
}

/** Virtual clock shared by the harness and the brain modules (they call Date.now()). */
const realNow = Date.now;
let virtualMs = 0;
let virtual = false;
Date.now = () => (virtual ? virtualMs : realNow());

/** Standing on ground: not jumping and not sinking (the game's jump flag stays clear while falling off a ledge). */
function solid(obs: Observation, prev: Observation | undefined): boolean {
  return obs.ai.alive && obs.ai.onGround && prev !== undefined && prev.ai.alive && prev.ai.y === obs.ai.y;
}

export async function runEpisode(o: HarnessOptions): Promise<EpisodeReport> {
  const useJev = Boolean(o.jev) && jevEnabled();
  if (o.jev && !jevEnabled()) process.stderr.write("Jev requested but no key configured: running reflex-only\n");
  // Solo: the buddy takes controller 1 in a 1-player game. The profile's "human" becomes the absent player 2.
  const game: GameProfile = o.mode === "solo" ? { ...o.game, players: { human: o.game.players.ai, ai: o.game.players.human }, start: { ...o.game.start, requirePlayerMode: 0 } } : o.game;
  const bytes = fs.readFileSync(romPath(game));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const nes = new jsnes.NES({ onFrame() {}, onAudioSample: null });
  nes.loadROM(bin);
  const mem = nes.cpu.mem;
  const started = realNow();
  virtual = !useJev;
  virtualMs = realNow();

  let frame = 0;
  const levelAddr = game.ram.level ? parseAddr(game.ram.level) : -1;
  const invAddr = game.ram.invincible ? parseAddr(game.ram.invincible[game.players.ai - 1]) : -1;
  const step = () => {
    if (o.invincible && invAddr >= 0) mem[invAddr] = 0x40;
    nes.frame();
    frame++;
    if (virtual) virtualMs += 1000 / 60;
    o.onFrame?.(nes.cpu, frame);
  };
  const tapNow = (c: number, b: number, frames: number) => {
    nes.buttonDown(c, b);
    for (let i = 0; i < frames; i++) step();
    nes.buttonUp(c, b);
  };

  // ── title screen: the seed decides how long we linger (the game's RNG runs on the frame counter)
  const total = game.ramRanges.reduce((n, [a, b]) => n + (b - a), 0);
  const snapshot = (): Uint8Array => {
    const out = new Uint8Array(total);
    let off = 0;
    for (const [a, b] of game.ramRanges) {
      for (let i = a; i < b; i++) out[off++] = mem[i] ?? 0;
    }
    return out;
  };
  const phaseOf = () => observe(game, snapshot()).phase;
  for (let i = 0; i < 300 + (o.seed % 97) * 3; i++) step();
  const menuC = game.start.controller ?? 1;
  const wantMode = game.start.requirePlayerMode ?? 0;
  for (let tries = 0; tries < 40 && phaseOf() !== "playing"; tries++) {
    const ob = observe(game, snapshot());
    if (ob.phase === "title" && ob.playerMode !== wantMode) tapNow(menuC, BTN[game.start.selectButton as Button], 4);
    else if (ob.phase === "title" || (game.start.loadingStart && ob.phase === "loading")) tapNow(menuC, BTN[game.start.startButton as Button], 6);
    for (let i = 0; i < 40; i++) {
      // The level byte is reset by the game's init and read while loading: keep writing it until play starts.
      if (o.level && levelAddr >= 0 && phaseOf() !== "playing") mem[levelAddr] = o.level;
      step();
    }
  }
  if (phaseOf() !== "playing") throw new Error(`could not start the game (phase ${phaseOf()} after ${frame} frames)`);

  // ── the brain
  const held = new Set<number>();
  const turbo = new Set<number>();
  const trail: string[] = [];
  const actions: Record<string, number> = {};
  let aiController = game.players.ai;
  const jumps: JumpRecord[] = [];
  let pendingJump: { x: number; y: number; level: number; targetY?: number; frame: number } | undefined;
  let lastAct: Observation | undefined;
  const send = (m: BuddyMessage) => {
    if (m.type === "act") {
      if (m.hold.includes(game.buttons.jump as Button) && lastAct?.ai.alive && lastAct.ai.onGround && !pendingJump) pendingJump = { x: lastAct.ai.levelX, y: lastAct.ai.y, level: lastAct.level, frame };
      if (m.controller !== aiController) {
        for (let b = 0; b < 8; b++) nes.buttonUp(aiController, b);
        aiController = m.controller;
      }
      held.clear();
      turbo.clear();
      for (const b of m.hold) held.add(BTN[b]);
      for (const b of m.turbo) turbo.add(BTN[b]);
      trail.push(`${m.tag}`);
      if (trail.length > 8) trail.shift();
      actions[m.tag] = (actions[m.tag] ?? 0) + 1;
    } else if (m.type === "op") {
      if (m.src !== "system" && trail.length) trail[trail.length - 1] = `${trail[trail.length - 1]} [${m.text.replace(/^[A-Z+* ]+\s{2}/, "")}]`;
      const target = /jump (?:to the next one|straight up onto the ledge) \(dx -?\d+, dy (-?\d+)\)|route: jump.*\(dx -?\d+, dy (-?\d+)\)/.exec(m.text);
      if (target && pendingJump && frame - pendingJump.frame < 6) pendingJump.targetY = pendingJump.y + Number(target[1] ?? target[2]);
      if (o.verbose) process.stdout.write(`  [${m.src}] ${m.text}\n`);
    }
  };
  // The harness handled the menus itself; the brain only ever sees the game running.
  const brain = new BuddyBrain({ game, send: o.explore ? () => {} : send, jev: useJev && !o.explore, quiet: true });

  const deaths: DeathRecord[] = [];
  const ground: Record<string, Record<string, number[]>> = {};
  let prev: Observation | undefined;
  let lastSolid: Observation | undefined;
  let yHist: number[] = [];
  let stillFrames = 0;
  let lastX = -1;
  let partnerDeaths = 0;
  let lifeStartX = 0;
  let lifeMaxX = 0;
  let distance = 0;
  let level = o.level ?? 0;
  let progress = 0;
  const maxFrames = o.maxFrames ?? 60 * 240;
  let progressAt = 0;
  let stuckAt: number | undefined;
  let lastBigHp = 0;
  let levelsCleared = 0;
  const humanC = game.players.human;

  // Explorer: a seeded PRNG decides when to jump and when to double back for a moment.
  let rng = (o.seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    rng ^= rng << 13;
    rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng >>>= 0;
    return rng / 4294967296;
  };
  let exploreJumpAt = 0;
  let exploreBackUntil = 0;
  let exploreRespawnDir = 0;
  let exploreVertical = false;
  const exploreButtons = () => {
    if (frame >= exploreJumpAt) {
      exploreJumpAt = frame + 20 + Math.floor(rand() * 140);
      const r = rand();
      if (r < 0.15) exploreBackUntil = frame + 30 + Math.floor(rand() * 60);
      exploreVertical = r > 0.6; // a standing jump straight up finds the ledges overhead
    }
    held.clear();
    turbo.clear();
    // Respawning over a pit kills again and again: drift left or right (per life) while falling in.
    if (lastAct && !lastAct.ai.alive && lastAct.ai.state === game.playerState.falling) {
      if (exploreRespawnDir === 0) exploreRespawnDir = rand() < 0.5 ? BTN.LEFT : BTN.RIGHT;
      held.add(exploreRespawnDir);
      return;
    }
    exploreRespawnDir = 0;
    const jumping = frame >= exploreJumpAt - 8 && frame < exploreJumpAt;
    const standing = exploreVertical && frame >= exploreJumpAt - 14 && frame < exploreJumpAt + 30;
    if (!standing) held.add(frame < exploreBackUntil ? BTN.LEFT : BTN.RIGHT);
    turbo.add(BTN.B);
    if (jumping) held.add(BTN.A);
    if (frame === exploreJumpAt - 8 && lastAct?.ai.alive && lastAct.ai.onGround && !pendingJump) pendingJump = { x: lastAct.ai.levelX, y: lastAct.ai.y, level: lastAct.level, frame };
  };

  const applyButtons = () => {
    if (o.explore) exploreButtons();
    for (let b = 0; b < 8; b++) {
      let down = held.has(b);
      if (turbo.has(b)) down = ((frame >> 2) & 1) === 1;
      if (down) nes.buttonDown(aiController, b);
      else nes.buttonUp(aiController, b);
    }
    if (o.mode === "duo") {
      // Scripted partner: run right, fire, hop every 3 s (the same dummy as scripts/headless-play.mjs).
      nes.buttonDown(humanC, BTN.RIGHT);
      if ((frame >> 2) & 1) nes.buttonDown(humanC, BTN.B);
      else nes.buttonUp(humanC, BTN.B);
      if (frame % 180 === 0) nes.buttonDown(humanC, BTN.A);
      else nes.buttonUp(humanC, BTN.A);
    }
  };

  const tick = () => {
    const obs = observe(game, snapshot(), prev);
    if (obs.phase === "playing") {
      if (obs.level !== level) {
        if (obs.level > level) levelsCleared++;
        level = obs.level;
        progress = 0;
        lifeStartX = obs.ai.levelX;
        lifeMaxX = lifeStartX;
      }
      if (obs.ai.alive) {
        if (obs.ai.levelX > lifeMaxX) lifeMaxX = obs.ai.levelX;
        if (obs.ai.levelX > progress) {
          progress = obs.ai.levelX;
          progressAt = frame;
        }
        // Wearing a wall or boss down is progress too (the screen is locked, x cannot grow).
        const bigHp = obs.enemies.filter((e) => (e.category === "hostile" || e.category === "obstacle") && e.hp >= 8).reduce((n, e) => n + e.hp, 0);
        if (bigHp < lastBigHp) progressAt = frame;
        lastBigHp = bigHp;
        if (frame - progressAt > 60 * 30 && stuckAt === undefined) stuckAt = obs.ai.levelX;
        if (obs.ai.x === lastX) stillFrames += 2.5;
        else stillFrames = 0;
        lastX = obs.ai.x;
        if (solid(obs, prev)) {
          lastSolid = obs;
          if (pendingJump && frame - pendingJump.frame > 20) {
            const ok = pendingJump.targetY === undefined ? true : Math.abs(obs.ai.y - pendingJump.targetY) <= 6;
            jumps.push({ level: pendingJump.level, x: pendingJump.x, y: pendingJump.y, targetY: pendingJump.targetY, landedX: obs.ai.levelX, landedY: obs.ai.y, ok });
            pendingJump = undefined;
          }
          const g = (ground[String(obs.level)] ??= {});
          const key = String(Math.floor(obs.ai.levelX / 8) * 8);
          const ys = (g[key] ??= []);
          if (!ys.includes(obs.ai.y)) ys.push(obs.ai.y);
        }
        yHist.push(obs.ai.y);
        if (yHist.length > 10) yHist.shift();
      }
      if (prev?.ai.alive && !obs.ai.alive) {
        // Died. Classify from what we saw just before.
        const p = prev;
        const rising = yHist.length >= 4 && yHist.every((y, i) => i === 0 || y >= yHist[i - 1]!) && yHist[yHist.length - 1]! - yHist[0]! >= 10;
        if (pendingJump) {
          // A fall after a jump is a miss (the ledge was not where the map says); a shot in the air says nothing.
          const fell = (rising && p.ai.y >= 200) || p.ai.y >= 232;
          jumps.push({ level: pendingJump.level, x: pendingJump.x, y: pendingJump.y, targetY: pendingJump.targetY, landedX: p.ai.levelX, landedY: 240, ok: false, died: !fell });
          pendingJump = undefined;
        }
        const near = p.enemies
          .map((e) => ({ category: e.category, type: e.type, dx: e.x - p.ai.x, dy: e.y - p.ai.y, vx: e.vx, vy: e.vy }))
          .filter((e) => e.category === "projectile" || e.category === "hostile")
          .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
        const killer = near[0];
        let cause: DeathCause = "unknown";
        if ((rising && p.ai.y >= 200) || p.ai.y >= 232) cause = lastSolid ? "fall" : "respawn";
        else if (killer && Math.abs(killer.dx) <= (killer.category === "hostile" ? 34 : 24) && Math.abs(killer.dy) <= 28) cause = killer.category === "projectile" ? "shot" : "contact";
        else if (killer && killer.category === "projectile" && Math.abs(killer.dx) <= 40) cause = "shot";
        const shooterObj = cause === "shot" && killer ? p.enemies.filter((e) => e.category === "hostile").sort((a, b) => Math.abs(a.x - p.ai.x) + Math.abs(a.y - p.ai.y) - (Math.abs(b.x - p.ai.x) + Math.abs(b.y - p.ai.y)))[0] : undefined;
        deaths.push({
          frame,
          level: p.level,
          levelX: p.ai.levelX,
          y: p.ai.y,
          cause,
          fallFromX: cause === "fall" ? lastSolid?.ai.levelX : undefined,
          fallFromY: cause === "fall" ? lastSolid?.ai.y : undefined,
          killer,
          shooter: shooterObj ? { type: shooterObj.type, dx: shooterObj.x - p.ai.x, dy: shooterObj.y - p.ai.y } : undefined,
          onGround: p.ai.onGround,
          trail: [...trail],
          stillFrames: Math.round(stillFrames),
        });
        distance += Math.max(0, lifeMaxX - lifeStartX);
        yHist = [];
      }
      if (prev && !prev.ai.alive && obs.ai.alive) {
        lifeStartX = obs.ai.levelX;
        lifeMaxX = lifeStartX;
        progressAt = frame;
        lastSolid = undefined; // a fall right after respawning is not an edge the buddy walked off
        pendingJump = undefined;
      }
      if (prev?.human.alive && !obs.human.alive) partnerDeaths++;
    }
    prev = obs;
    lastAct = obs;
    brain.onObservation(snapshot());
    return obs;
  };

  const done = (obs: Observation | undefined) => frame >= maxFrames || stuckAt !== undefined || (obs !== undefined && (obs.phase === "gameover" || obs.phase === "ending"));
  let obs: Observation | undefined;
  if (useJev) {
    // Real-time pacing: 24 observations per second, 2–3 frames each, like the browser.
    let t = 0;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const burst = t++ % 2 ? 3 : 2;
        for (let k = 0; k < burst; k++) {
          applyButtons();
          step();
        }
        obs = tick();
        if (done(obs)) {
          clearInterval(timer);
          resolve();
        }
      }, 1000 / 24);
    });
  } else {
    let t = 0;
    while (!done(obs)) {
      const burst = t++ % 2 ? 3 : 2;
      for (let k = 0; k < burst; k++) {
        applyButtons();
        step();
      }
      obs = tick();
    }
  }
  if (prev?.ai.alive) distance += Math.max(0, lifeMaxX - lifeStartX);
  brain.stop();
  virtual = false;
  return { game: game.id, mode: o.mode, seed: o.seed, jev: useJev, frames: frame, level, progress, distance, deaths, jumps, partnerDeaths, ground, actions, stuckAt, levelsCleared, wallMs: realNow() - started };
}
