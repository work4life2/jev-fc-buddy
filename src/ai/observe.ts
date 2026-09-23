import type { EnemyCategory, GameProfile, TankProfile } from "../games/registry.js";

/**
 * Turns the raw RAM bytes the browser reports into a game-agnostic observation, using only the
 * addresses named in the game profile. Everything the policy, Jev and the coach see comes from here.
 */

export interface PlayerObs {
  x: number;
  y: number;
  state: number;
  alive: boolean;
  lives: number;
  gameOver: boolean;
  /** -1 left, 0 still, 1 right (signed byte in RAM) */
  xVel: number;
  onGround: boolean;
  /** Raw jump-animation flag is clear; unlike onGround, this can be true while falling. */
  jumpReady?: boolean;
  invincible: boolean;
  weapon: number;
  /** Level-x (screen x + scroll), 0 when the profile has no scroll fields. */
  levelX: number;
  motion?: "grounded" | "ascending" | "descending" | "falling" | "respawning";
}

export interface EnemyObs {
  slot: number;
  x: number;
  y: number;
  type: number;
  hp: number;
  category: EnemyCategory;
  /**
   * Relative displacement over the last control observation (legacy reflex units).
   * Screen scrolling cancels out; 0 when the object was not seen before.
   */
  vx: number;
  vy: number;
  /** Exact relative pixels per emulator frame for model state and prediction. */
  vxPerFrame?: number;
  vyPerFrame?: number;
}

/** Direction index as top-down games count it: 0 up, 1 left, 2 down, 3 right. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_DX: Record<Dir, number> = { 0: 0, 1: -1, 2: 0, 3: 1 };
export const DIR_DY: Record<Dir, number> = { 0: -1, 1: 0, 2: 1, 3: 0 };

export interface TankObs {
  slot: number;
  x: number;
  y: number;
  /** Facing while moving; -1 when standing still (the sprite does not tell). */
  dir: Dir | -1;
  player: boolean;
  alive: boolean;
  spawning: boolean;
  exploding: boolean;
  frozen: boolean;
  /** Velocity per tick (px), from the previous observation of the same slot. */
  vx: number;
  vy: number;
}

export interface ShellObs {
  /** Owner tank slot (players 0/1 and their second shells 8/9). */
  slot: number;
  x: number;
  y: number;
  dir: Dir;
  enemy: boolean;
  /** Pixels per frame, measured between observations (profile default until seen twice). */
  speed: number;
}

export type Terrain = "empty" | "brick" | "steel" | "border" | "water" | "trees" | "ice" | "eagle" | "eagleDestroyed";

/** The arena of a top-down tank game. Coordinates are tank centres on an 8 px lattice. */
export interface TankWorld {
  tanks: TankObs[];
  shells: ShellObs[];
  item?: { x: number; y: number; type: number };
  /** Tile id per cell; cell(cx, cy) at cy*stride + cx. */
  cells: Uint8Array;
  stride: number;
  cell: number;
  field: { x0: number; y0: number; x1: number; y1: number };
  terrainOf: (id: number) => Terrain;
  eagle: { x: number; y: number; alive: boolean; cells: Array<[number, number]> };
  enemiesLeft: number;
  paused: boolean;
  /** Spawn-shield seconds left per player index. */
  shield: [number, number];
  speeds: { player: number; bullet: number; fastBullet: number };
  /** Emulator frames between this observation and the previous one (from the game's frame counter). */
  framesPerTick: number;
}

export interface Observation {
  game: string;
  frame: number;
  phase: string;
  playerMode: number;
  level: number;
  levelDirection: "right" | "up";
  /** Base corridor (3D view): the player stands on one floor line and fires into the screen. */
  corridor: boolean;
  ai: PlayerObs;
  human: PlayerObs;
  enemies: EnemyObs[];
  screen: { width: number; height: number };
  /** Horizontal level position of the left screen edge (0 when the profile has no scroll fields). */
  levelScrollX: number;
  /** Present for genre "tank". */
  tank?: TankWorld;
  at: number;
}

export class RamView {
  private readonly chunks: Array<{ start: number; end: number; offset: number }> = [];
  constructor(
    private readonly bytes: Uint8Array,
    ranges: Array<[number, number]>,
  ) {
    let offset = 0;
    for (const [start, end] of ranges) {
      this.chunks.push({ start, end, offset });
      offset += end - start;
    }
  }
  byte(addr: number): number {
    for (const c of this.chunks) if (addr >= c.start && addr < c.end) return this.bytes[c.offset + (addr - c.start)] ?? 0;
    return 0;
  }
  signed(addr: number): number {
    const b = this.byte(addr);
    return b > 127 ? b - 256 : b;
  }
}

export function parseAddr(s: string | undefined): number {
  if (!s) return -1;
  return s.startsWith("0x") || s.startsWith("0X") ? parseInt(s, 16) : parseInt(s, 10);
}

function phaseOf(game: GameProfile, ram: RamView): string {
  const gr = game.ram.gameRoutine ? ram.byte(parseAddr(game.ram.gameRoutine)) : -1;
  const lr = game.ram.levelRoutine ? ram.byte(parseAddr(game.ram.levelRoutine)) : -1;
  for (const [name, cond] of Object.entries(game.phases)) {
    if (cond.gameRoutine && !cond.gameRoutine.includes(gr)) continue;
    if (cond.levelRoutine && !cond.levelRoutine.includes(lr)) continue;
    return name;
  }
  return "other";
}

function playerOf(game: GameProfile, ram: RamView, idx: 0 | 1, phase: string, levelScrollX: number): PlayerObs {
  const r = game.ram;
  const state = ram.byte(parseAddr(r.playerState[idx]));
  const gameOver = r.gameOver ? ram.byte(parseAddr(r.gameOver[idx])) !== 0 : false;
  const jump = r.jumpStatus ? ram.byte(parseAddr(r.jumpStatus[idx])) : 0;
  return {
    x: ram.byte(parseAddr(r.playerX[idx])),
    y: ram.byte(parseAddr(r.playerY[idx])),
    state,
    alive: phase === "playing" && state === game.playerState.normal && !gameOver,
    lives: ram.byte(parseAddr(r.lives[idx])),
    gameOver,
    xVel: r.playerXVel ? Math.sign(ram.signed(parseAddr(r.playerXVel[idx]))) : 0,
    onGround: (jump & 0x0f) === 0,
    jumpReady: (jump & 0x0f) === 0,
    invincible: r.invincible ? ram.byte(parseAddr(r.invincible[idx])) !== 0 : false,
    weapon: r.weapon ? ram.byte(parseAddr(r.weapon[idx])) & 0x0f : 0,
    levelX: levelScrollX + ram.byte(parseAddr(r.playerX[idx])),
  };
}

function categoryOf(game: GameProfile, level: number, type: number): EnemyCategory {
  const t = game.enemyTypes;
  if (!t) return "hostile";
  const key = `0x${type.toString(16).padStart(2, "0")}`;
  return t.levelTypes?.[String(level)]?.[key] ?? t.shared[key] ?? t.default ?? "hostile";
}

function parseIdSet(specs: string[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const s of specs ?? []) {
    const m = /^(0x[0-9a-f]+|\d+)\s*-\s*(0x[0-9a-f]+|\d+)$/i.exec(s.trim());
    if (m) for (let v = parseAddr(m[1]); v <= parseAddr(m[2]); v++) out.add(v);
    else out.add(parseAddr(s.trim()));
  }
  return out;
}

const terrainCache = new WeakMap<TankProfile, (id: number) => Terrain>();

function terrainFn(t: TankProfile): (id: number) => Terrain {
  let fn = terrainCache.get(t);
  if (fn) return fn;
  const table: Array<[Terrain, Set<number>]> = (Object.keys(t.map.ids) as Terrain[]).map((k) => [k, parseIdSet(t.map.ids[k])]);
  const lut = new Array<Terrain>(256).fill("empty");
  for (let id = 0; id < 256; id++) {
    const hit = table.find(([, set]) => set.has(id));
    // Unknown ids are treated as solid: safer for both driving and shooting.
    lut[id] = hit ? hit[0] : "steel";
  }
  fn = (id) => lut[id & 0xff];
  terrainCache.set(t, fn);
  return fn;
}

function tankDir(t: TankProfile, sprite: number): Dir | -1 {
  return sprite >= t.sprite.moving[0] && sprite <= t.sprite.moving[1] ? ((sprite & 3) as Dir) : -1;
}

/** Player liveness for the tank genre: a tank sprite (moving or standing) with a real position. */
function tankAlive(t: TankProfile, sprite: number, x: number): boolean {
  if (x === 0xff) return false;
  return (sprite >= t.sprite.moving[0] && sprite <= t.sprite.moving[1]) || (sprite >= t.sprite.standing[0] && sprite <= t.sprite.standing[1]);
}

function observeTank(game: GameProfile, t: TankProfile, ram: RamView, prev: TankWorld | undefined, framesPerTick: number): TankWorld {
  const tx = parseAddr(t.tanks.x);
  const ty = parseAddr(t.tanks.y);
  const ts = parseAddr(t.tanks.sprite);
  const tf = t.tanks.flags ? parseAddr(t.tanks.flags) : -1;
  const tanks: TankObs[] = [];
  for (let i = 0; i < t.tanks.count; i++) {
    const x = ram.byte(tx + i);
    const y = ram.byte(ty + i);
    const sprite = ram.byte(ts + i);
    if (x === 0xff || sprite === 0) continue;
    const flags = tf >= 0 ? ram.byte(tf + i) : 0;
    const was = prev?.tanks.find((p) => p.slot === i);
    const spawning = sprite >= t.sprite.spawning[0] && sprite <= t.sprite.spawning[1];
    const exploding = sprite >= t.sprite.exploding[0] && sprite <= t.sprite.exploding[1];
    tanks.push({
      slot: i,
      x,
      y,
      dir: tankDir(t, sprite),
      player: t.tanks.playerSlots.includes(i),
      alive: tankAlive(t, sprite, x),
      spawning,
      exploding,
      frozen: (flags & 0x40) !== 0 && !t.tanks.playerSlots.includes(i),
      vx: was ? x - was.x : 0,
      vy: was ? y - was.y : 0,
    });
  }
  const bx = parseAddr(t.bullets.x);
  const by = parseAddr(t.bullets.y);
  const bs = parseAddr(t.bullets.state);
  const shells: ShellObs[] = [];
  const defaultSpeed = t.speeds?.bullet ?? 2;
  for (let i = 0; i < t.bullets.count; i++) {
    const state = ram.byte(bs + i);
    if ((state & 0xf0) !== 0x40) continue;
    const owner = i >= t.tanks.count ? i - t.tanks.count : i; // second player shells map back to the player
    const dir = (state & 3) as Dir;
    const x = ram.byte(bx + i);
    const y = ram.byte(by + i);
    const was = prev?.shells.find((s) => s.slot === i && s.dir === dir);
    const moved = was ? Math.abs(x - was.x) + Math.abs(y - was.y) : 0;
    // Only a plausible straight-line delta counts (1..8 px per frame); otherwise keep what we knew.
    const perFrame = moved / Math.max(1, framesPerTick);
    const speed = was && perFrame >= 1 && perFrame <= 8 ? perFrame : (was?.speed ?? defaultSpeed);
    shells.push({ slot: i, x, y, dir, enemy: !t.tanks.playerSlots.includes(owner), speed });
  }
  const cells = new Uint8Array(t.map.stride * 30);
  const base = parseAddr(t.map.base);
  for (let i = 0; i < cells.length; i++) cells[i] = ram.byte(base + i);
  const terrainOf = terrainFn(t);
  const eagleAlive = t.eagle.cells.every(([cx, cy]) => terrainOf(cells[cy * t.map.stride + cx]) === "eagle");
  const item = t.item ? { x: ram.byte(parseAddr(t.item.x)), y: ram.byte(parseAddr(t.item.y)), type: ram.byte(parseAddr(t.item.type)) } : undefined;
  const inv = game.ram.invincible;
  return {
    tanks,
    shells,
    item: item && item.x !== 0 && item.x !== 0xff ? item : undefined,
    cells,
    stride: t.map.stride,
    cell: t.map.cell,
    field: t.map.field,
    terrainOf,
    eagle: { x: t.eagle.x, y: t.eagle.y, alive: eagleAlive, cells: t.eagle.cells },
    enemiesLeft: t.enemiesLeft ? ram.byte(parseAddr(t.enemiesLeft)) : 0,
    paused: t.pause ? ram.byte(parseAddr(t.pause)) === 1 : false,
    shield: [inv ? ram.byte(parseAddr(inv[0])) : 0, inv ? ram.byte(parseAddr(inv[1])) : 0],
    speeds: { player: t.speeds?.player ?? 0.75, bullet: t.speeds?.bullet ?? 2, fastBullet: t.speeds?.fastBullet ?? 4 },
    framesPerTick,
  };
}

export function observe(game: GameProfile, bytes: Uint8Array, prev?: Observation): Observation {
  const ram = new RamView(bytes, game.ramRanges);
  const phase = phaseOf(game, ram);
  if ((game.genre === "tank" || game.tank) && game.tank) return observeTankGame(game, game.tank, ram, phase, prev);
  const aiIdx = (game.players.ai - 1) as 0 | 1;
  const humanIdx = (game.players.human - 1) as 0 | 1;
  const level = game.ram.level ? ram.byte(parseAddr(game.ram.level)) : 0;
  if (prev && (prev.level !== level || prev.phase !== phase)) prev = undefined;
  const frame = game.ram.frame ? ram.byte(parseAddr(game.ram.frame)) : 0;
  const elapsedFrames = prev && game.ram.frame ? (frame - prev.frame + 256) % 256 : 2.5;
  const levelScrollX = game.ram.screenNumber && game.ram.screenScroll ? ram.byte(parseAddr(game.ram.screenNumber)) * 256 + ram.byte(parseAddr(game.ram.screenScroll)) : 0;
  const aiNow = playerOf(game, ram, aiIdx, phase, levelScrollX);
  const humanNow = playerOf(game, ram, humanIdx, phase, levelScrollX);
  for (const [current, before] of [[aiNow, prev?.ai], [humanNow, prev?.human]] as const) {
    const dy = before?.alive && current.alive ? current.y - before.y : 0;
    current.motion = !current.alive ? "respawning" : current.onGround && dy > 0 ? "falling" : !current.onGround ? (dy < 0 ? "ascending" : "descending") : "grounded";
    if (current.motion === "falling") current.onGround = false;
  }
  const enemies: EnemyObs[] = [];
  const e = game.ram.enemies;
  if (e) {
    const routine = parseAddr(e.routine);
    const ex = parseAddr(e.x);
    const ey = parseAddr(e.y);
    const et = e.type ? parseAddr(e.type) : -1;
    const eh = e.hp ? parseAddr(e.hp) : -1;
    for (let i = 0; i < e.count; i++) {
      if (ram.byte(routine + i) === 0) continue;
      const type = et >= 0 ? ram.byte(et + i) : 0;
      const category = categoryOf(game, level, type);
      if (category === "ignore") continue;
      const x = ram.byte(ex + i);
      const y = ram.byte(ey + i);
      const was = prev?.enemies.find((p) => p.slot === i && p.type === type);
      const vx = was ? x - aiNow.x - (was.x - prev!.ai.x) : 0;
      const vy = was ? y - aiNow.y - (was.y - prev!.ai.y) : 0;
      const safeX = Math.abs(vx) > 48 ? 0 : vx;
      const safeY = Math.abs(vy) > 48 ? 0 : vy;
      enemies.push({ slot: i, x, y, type, hp: eh >= 0 ? ram.byte(eh + i) : 0, category, vx: safeX, vy: safeY, vxPerFrame: safeX / Math.max(1, elapsedFrames), vyPerFrame: safeY / Math.max(1, elapsedFrames) });
    }
  }
  const scrollType = game.ram.scrollType ? ram.byte(parseAddr(game.ram.scrollType)) : 0;
  return {
    game: game.id,
    frame,
    phase,
    playerMode: game.ram.playerMode ? ram.byte(parseAddr(game.ram.playerMode)) : 1,
    level,
    levelDirection: scrollType === 1 ? "up" : "right",
    corridor: game.ram.locationType ? ram.byte(parseAddr(game.ram.locationType)) === 1 : false,
    ai: aiNow,
    human: humanNow,
    enemies,
    screen: game.screen,
    levelScrollX,
    at: Date.now(),
  };
}

/**
 * Tank genre: the same Observation shape (so deaths, the coach snapshot and the ops stream work
 * unchanged) plus `tank`, the arena. `enemies` lists enemy tanks as hostiles, enemy shells as
 * projectiles and the power-up as an item, all in screen coordinates.
 */
function observeTankGame(game: GameProfile, t: TankProfile, ram: RamView, phase: string, prev?: Observation): Observation {
  const aiIdx = (game.players.ai - 1) as 0 | 1;
  const humanIdx = (game.players.human - 1) as 0 | 1;
  const frame = game.ram.frame ? ram.byte(parseAddr(game.ram.frame)) : 0;
  const framesPerTick = prev ? Math.min(15, Math.max(1, (frame - prev.frame + 256) % 256)) : 3;
  const world = observeTank(game, t, ram, prev?.tank, framesPerTick);
  const player = (idx: 0 | 1): PlayerObs => {
    const slot = t.tanks.playerSlots[idx];
    const tank = world.tanks.find((k) => k.slot === slot);
    const lives = ram.byte(parseAddr(game.ram.lives[idx]));
    return {
      x: tank?.x ?? 0,
      y: tank?.y ?? 0,
      state: tank ? ram.byte(parseAddr(t.tanks.sprite) + slot) : 0,
      alive: phase === "playing" && !!tank?.alive && !world.paused,
      lives: lives === 0xff ? 0 : lives,
      gameOver: !world.eagle.alive,
      xVel: tank ? Math.sign(tank.vx) : 0,
      onGround: true,
      invincible: world.shield[idx] > 0,
      weapon: 0,
      levelX: tank?.x ?? 0,
    };
  };
  const ai = player(aiIdx);
  const enemies: EnemyObs[] = [];
  for (const k of world.tanks) {
    if (k.player || !k.alive) continue;
    enemies.push({ slot: k.slot, x: k.x, y: k.y, type: k.spawning ? 0xe0 : 0x80, hp: 1, category: "hostile", vx: k.vx, vy: k.vy });
  }
  for (const s of world.shells) {
    if (!s.enemy) continue;
    const was = prev?.enemies.find((p) => p.slot === 16 + s.slot && p.category === "projectile");
    enemies.push({ slot: 16 + s.slot, x: s.x, y: s.y, type: 0x40 | s.dir, hp: 0, category: "projectile", vx: was ? s.x - was.x : DIR_DX[s.dir] * 5, vy: was ? s.y - was.y : DIR_DY[s.dir] * 5 });
  }
  if (world.item) enemies.push({ slot: 32, x: world.item.x, y: world.item.y, type: world.item.type, hp: 0, category: "item", vx: 0, vy: 0 });
  return {
    game: game.id,
    frame,
    phase,
    playerMode: game.ram.playerMode ? ram.byte(parseAddr(game.ram.playerMode)) : 1,
    level: game.ram.level ? ram.byte(parseAddr(game.ram.level)) : 0,
    levelDirection: "right",
    corridor: false,
    ai,
    human: player(humanIdx),
    enemies,
    screen: game.screen,
    levelScrollX: 0,
    tank: world,
    at: Date.now(),
  };
}
