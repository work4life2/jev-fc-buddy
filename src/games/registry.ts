import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("games");

/**
 * A game is a folder under games/<id>/ with a game.json profile. The profile describes where the
 * ROM is, which RAM addresses carry the observable state, how to start a 2-player game, and what to
 * tell the coach model about the game. Nothing outside games/ is specific to any single title.
 */
export type EnemyCategory = "hostile" | "projectile" | "item" | "obstacle" | "hazard" | "ignore";

/**
 * Which family of reflexes drives the buddy. `run-and-gun` (default) is the side-scroller policy
 * (follow / cover / jump / prone); `tank` is the top-down arena policy (lanes, shells, a base to
 * protect) that reads the object tables described in `tank`.
 */
export type Genre = "run-and-gun" | "tank";

/** Top-down tank games: object tables and the tile map, all as CPU addresses. */
export interface TankProfile {
  note?: string;
  tanks: { count: number; x: string; y: string; sprite: string; flags?: string; playerSlots: [number, number] };
  /** Inclusive sprite-id ranges that tell a tank's state apart. Moving sprites encode the direction in the low 2 bits (0 up, 1 left, 2 down, 3 right). */
  sprite: { moving: [number, number]; standing: [number, number]; spawning: [number, number]; exploding: [number, number] };
  bulletsNote?: string;
  /** Slot i belongs to tank i; the state byte is 0x40 | direction while flying, 0 when free. */
  bullets: { count: number; x: string; y: string; state: string };
  itemNote?: string;
  item?: { x: string; y: string; type: string };
  mapNote?: string;
  map: {
    base: string;
    stride: number;
    cell: number;
    field: { x0: number; y0: number; x1: number; y1: number };
    /** Tile ids (or "0xNN-0xMM" ranges) per terrain kind. */
    ids: Partial<Record<"empty" | "brick" | "steel" | "border" | "water" | "trees" | "ice" | "eagle" | "eagleDestroyed", string[]>>;
  };
  eagle: { x: number; y: number; cells: Array<[number, number]> };
  enemiesLeft?: string;
  pause?: string;
  speeds?: { player?: number; bullet?: number; fastBullet?: number };
}

export interface GameProfile {
  id: string;
  title: string;
  titleLocal?: string;
  system: "nes";
  genre?: Genre;
  rom: string;
  romSha256?: string;
  screen: { width: number; height: number };
  /** Controller numbers (1-based, as jsnes counts them). */
  players: { human: number; ai: number };
  buttons: { jump: string; fire: string; prone?: string; aimUp?: string };
  /** Byte ranges the browser reports every tick: [start, end) in CPU address space. */
  ramRanges: Array<[number, number]>;
  ram: {
    frame?: string;
    gameRoutine?: string;
    levelRoutine?: string;
    playerMode?: string;
    level?: string;
    lives: [string, string];
    gameOver?: [string, string];
    playerState: [string, string];
    playerX: [string, string];
    playerY: [string, string];
    playerXVel?: [string, string];
    jumpStatus?: [string, string];
    invincible?: [string, string];
    death?: [string, string];
    weapon?: [string, string];
    scrollType?: string;
    locationType?: string;
    screenNumber?: string;
    /** Pixels scrolled into screenNumber; levelX = screenNumber*256 + screenScroll + screen x. */
    screenScroll?: string;
    bossDefeated?: string;
    enemies?: { count: number; routine: string; x: string; y: string; type?: string; hp?: string };
  };
  phases: Record<string, { gameRoutine?: number[]; levelRoutine?: number[] }>;
  playerState: { falling: number; normal: number; dead: number; frozen: number };
  /** ENEMY_TYPE id → category. Ids above the shared range differ per level. */
  enemyTypes?: {
    shared: Record<string, EnemyCategory>;
    levelTypes?: Record<string, Record<string, EnemyCategory>>;
    default?: EnemyCategory;
    note?: string;
    /** Stationary shooters by type id → minimum horizontal distance to keep. */
    keepDistance?: Record<string, number | string>;
  };
  /** Known pits per level (level-x ranges), e.g. bridges that explode once crossed. */
  terrain?: { gaps?: Record<string, Array<[number, number] | [number, number, number, number] | [number, number, number, number, "pit" | "bridge" | "hop"]>>; note?: string; gapNote?: string };
  /** `loadingStart`: the game also waits for START on a loading / stage-select screen (phase "loading"). */
  /** `controller`: controller the AI uses for the title/stage-screen taps when it differs from `players.ai` (Battle City: only controller 1 works there). */
  start: { requirePlayerMode?: number; selectButton: string; startButton: string; loadingStart?: boolean; controller?: number; note?: string };
  reflex: { followDistance: number; engageDistance: number; closeDistance: number; aimUpHeight: number; dodgeDistance?: number; itemDistance?: number; turboFire: boolean };
  /** Present for genre "tank". */
  tank?: TankProfile;
  coachBrief: string;
}

export function genreOf(g: GameProfile): Genre {
  return g.genre ?? (g.tank ? "tank" : "run-and-gun");
}

let cache: Map<string, GameProfile> | undefined;

export function listGames(): GameProfile[] {
  if (cache) return [...cache.values()];
  cache = new Map();
  const dir = getConfig().gamesDir;
  if (!fs.existsSync(dir)) return [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "game.json");
    if (!fs.existsSync(file)) continue;
    try {
      const profile = JSON.parse(fs.readFileSync(file, "utf8")) as GameProfile;
      profile.id ||= entry.name;
      cache.set(profile.id, profile);
    } catch (err) {
      log.warn(`skipping ${file}: ${String(err)}`);
    }
  }
  return [...cache.values()];
}

export function getGame(id: string): GameProfile | undefined {
  listGames();
  return cache?.get(id);
}

export function romPath(game: GameProfile): string {
  return path.join(getConfig().romsDir, game.rom);
}

export function romAvailable(game: GameProfile): boolean {
  return fs.existsSync(romPath(game));
}

/** Games whose ROM is present — the only ones a player can start. */
export function playableGames(): GameProfile[] {
  return listGames().filter(romAvailable);
}

/** Public, ROM-free description for the web client. */
export function publicGame(g: GameProfile) {
  return {
    id: g.id,
    title: g.title,
    titleLocal: g.titleLocal,
    system: g.system,
    genre: genreOf(g),
    screen: g.screen,
    players: g.players,
    buttons: g.buttons,
    ramRanges: g.ramRanges,
    available: romAvailable(g),
  };
}
