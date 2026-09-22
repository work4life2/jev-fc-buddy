import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getSessionMinutes } from "../runtimeConfig.js";

/**
 * Coin codes: a buyer pays N dollars on Termix and receives one code worth N coins. One coin
 * opens one play window of SESSION_MINUTES (operator-adjustable at runtime); the window starts
 * when the coin is inserted and keeps running whether or not the player stays on the page, so
 * leaving and coming back within the window costs nothing (now - insertedAt < minutes).
 * Codes live in DATA_DIR/coins.json; the file is the source of truth and is rewritten atomically.
 */

export interface CoinWindow {
  id: string;
  gameId: string;
  startedAt: string;
  /** When this coin's play window closes (ISO). Older records without it are treated as closed. */
  expiresAt?: string;
  endedAt?: string;
  reason?: string;
  /** How many times the player (re)entered this window. */
  entries?: number;
  /** Accumulated over every browser session of this window: what the AI cost. */
  usage?: WindowUsage;
}

export interface WindowUsage {
  /** Seconds a browser was connected and the game was being observed. */
  playSeconds: number;
  jevCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, from JEV_PRICE_*_PER_M. */
  estCost: number;
}

export interface CoinCode {
  code: string;
  coins: number;
  used: number;
  createdAt: string;
  /** Termix order the code was sold in, or "local" for operator-minted codes. */
  orderId: string;
  buyer?: string;
  note?: string;
  sessions: CoinWindow[];
}

interface CoinFile {
  codes: Record<string, CoinCode>;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function file(): string {
  return path.join(getConfig().dataDir, "coins.json");
}

let mem: CoinFile | undefined;

function load(): CoinFile {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(file(), "utf8")) as CoinFile;
  } catch {
    mem = { codes: {} };
  }
  mem.codes ??= {};
  return mem;
}

function save(): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
  fs.renameSync(tmp, f);
}

export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = getConfig().coins.codePrefix.toUpperCase();
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return body;
}

function formatCode(body: string): string {
  return `${getConfig().coins.codePrefix.toUpperCase()}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function randomBody(): string {
  const bytes = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** Mint a code worth `coins` coins. */
export function mintCode(coins: number, meta: { orderId: string; buyer?: string; note?: string }): CoinCode {
  const db = load();
  let body = randomBody();
  while (db.codes[body]) body = randomBody();
  const rec: CoinCode = { code: formatCode(body), coins: Math.max(1, Math.floor(coins)), used: 0, createdAt: new Date().toISOString(), orderId: meta.orderId, buyer: meta.buyer, note: meta.note, sessions: [] };
  db.codes[body] = rec;
  save();
  return rec;
}

export function findCode(input: string): CoinCode | undefined {
  const body = normalizeCode(input);
  if (body.length !== 12) return undefined;
  return load().codes[body];
}

export function findCodeByOrder(orderId: string): CoinCode | undefined {
  return Object.values(load().codes).find((c) => c.orderId === orderId);
}

export function remaining(c: CoinCode): number {
  return Math.max(0, c.coins - c.used);
}

/** The coin window that is still running on this code, if any (not ended by time, expiresAt in the future). */
export function activeWindow(c: CoinCode, now = Date.now()): CoinWindow | undefined {
  for (let i = c.sessions.length - 1; i >= 0; i--) {
    const w = c.sessions[i];
    if (!w.expiresAt) continue;
    if (w.reason === "time is up") continue;
    if (Date.parse(w.expiresAt) > now) return w;
  }
  return undefined;
}

export interface SpendResult {
  code: CoinCode;
  window: CoinWindow;
  /** True when an already-running window was re-entered instead of spending a coin. */
  resumed: boolean;
}

/**
 * Insert a coin: re-enter the running window if there is one, otherwise spend one coin and open a
 * new window of the configured minutes. Returns undefined when the code is unknown or exhausted.
 */
export function spendCoin(input: string, gameId: string): SpendResult | undefined {
  const c = findCode(input);
  if (!c) return undefined;
  const now = Date.now();
  const running = activeWindow(c, now);
  if (running) {
    running.entries = (running.entries ?? 1) + 1;
    running.endedAt = undefined;
    running.reason = undefined;
    save();
    return { code: c, window: running, resumed: true };
  }
  if (remaining(c) <= 0) return undefined;
  const window: CoinWindow = {
    id: crypto.randomBytes(8).toString("hex"),
    gameId,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + getSessionMinutes() * 60_000).toISOString(),
    entries: 1,
  };
  c.used += 1;
  c.sessions.push(window);
  save();
  return { code: c, window, resumed: false };
}

/** Record how a window ended. "player quit" keeps the window open for re-entry; "time is up" closes it. */
export function closeSession(codeInput: string, windowId: string, reason: string): void {
  const c = findCode(codeInput);
  const s = c?.sessions.find((x) => x.id === windowId);
  if (!s) return;
  s.endedAt = new Date().toISOString();
  s.reason = reason;
  save();
}

/** Fold one browser session's AI usage into its coin window (called when the session's brain stops). */
export function addWindowUsage(codeInput: string, windowId: string, u: { playSeconds: number; jevCalls: number; inputTokens: number; outputTokens: number }): void {
  const c = findCode(codeInput);
  const w = c?.sessions.find((x) => x.id === windowId);
  if (!w || (!u.jevCalls && !u.playSeconds)) return;
  const { typesafe } = getConfig();
  const t = (w.usage ??= { playSeconds: 0, jevCalls: 0, inputTokens: 0, outputTokens: 0, estCost: 0 });
  t.playSeconds += u.playSeconds;
  t.jevCalls += u.jevCalls;
  t.inputTokens += u.inputTokens;
  t.outputTokens += u.outputTokens;
  t.estCost = (t.inputTokens * typesafe.priceInPerM + t.outputTokens * typesafe.priceOutPerM) / 1e6;
  save();
}

export function listCodes(): CoinCode[] {
  return Object.values(load().codes).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Coins for an order price in the listing currency (USD-pegged stablecoins count 1:1). */
export function coinsForPrice(price: string | number): number {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor(n * getConfig().coins.perDollar));
}
