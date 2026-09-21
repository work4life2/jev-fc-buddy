import type { EnemyCategory, GameProfile } from "../games/registry.js";

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
  invincible: boolean;
  weapon: number;
  /** Level-x (screen x + scroll), 0 when the profile has no scroll fields. */
  levelX: number;
}

export interface EnemyObs {
  slot: number;
  x: number;
  y: number;
  type: number;
  hp: number;
  category: EnemyCategory;
  /**
   * Velocity per tick RELATIVE to the buddy (change of dx/dy since the previous observation of the
   * same slot+type). Screen scrolling cancels out; 0 when the object was not seen before.
   */
  vx: number;
  vy: number;
}

export interface Observation {
  game: string;
  frame: number;
  phase: string;
  playerMode: number;
  level: number;
  levelDirection: "right" | "up";
  ai: PlayerObs;
  human: PlayerObs;
  enemies: EnemyObs[];
  screen: { width: number; height: number };
  /** Horizontal level position of the left screen edge (0 when the profile has no scroll fields). */
  levelScrollX: number;
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

export function observe(game: GameProfile, bytes: Uint8Array, prev?: Observation): Observation {
  const ram = new RamView(bytes, game.ramRanges);
  const phase = phaseOf(game, ram);
  const aiIdx = (game.players.ai - 1) as 0 | 1;
  const humanIdx = (game.players.human - 1) as 0 | 1;
  const level = game.ram.level ? ram.byte(parseAddr(game.ram.level)) : 0;
  const levelScrollX = game.ram.screenNumber && game.ram.screenScroll ? ram.byte(parseAddr(game.ram.screenNumber)) * 256 + ram.byte(parseAddr(game.ram.screenScroll)) : 0;
  const aiNow = playerOf(game, ram, aiIdx, phase, levelScrollX);
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
      enemies.push({ slot: i, x, y, type, hp: eh >= 0 ? ram.byte(eh + i) : 0, category, vx: Math.abs(vx) > 48 ? 0 : vx, vy: Math.abs(vy) > 48 ? 0 : vy });
    }
  }
  const scrollType = game.ram.scrollType ? ram.byte(parseAddr(game.ram.scrollType)) : 0;
  return {
    game: game.id,
    frame: game.ram.frame ? ram.byte(parseAddr(game.ram.frame)) : 0,
    phase,
    playerMode: game.ram.playerMode ? ram.byte(parseAddr(game.ram.playerMode)) : 1,
    level,
    levelDirection: scrollType === 1 ? "up" : "right",
    ai: aiNow,
    human: playerOf(game, ram, humanIdx, phase, levelScrollX),
    enemies,
    screen: game.screen,
    levelScrollX,
    at: Date.now(),
  };
}
