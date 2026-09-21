import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";

/**
 * Coin codes: a buyer pays N dollars on Termix and receives one code worth N coins. One coin
 * buys one play session (COIN_SESSION_MINUTES, or until game over). Codes live in
 * DATA_DIR/coins.json; the file is the source of truth and is rewritten atomically.
 */

export interface CoinCode {
  code: string;
  coins: number;
  used: number;
  createdAt: string;
  /** Termix order the code was sold in, or "local" for operator-minted codes. */
  orderId: string;
  buyer?: string;
  note?: string;
  sessions: Array<{ id: string; gameId: string; startedAt: string; endedAt?: string; reason?: string }>;
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
  return load().codes[body];
}

export function findCodeByOrder(orderId: string): CoinCode | undefined {
  return Object.values(load().codes).find((c) => c.orderId === orderId);
}

export function remaining(c: CoinCode): number {
  return Math.max(0, c.coins - c.used);
}

/** Spend one coin and open a session. Returns undefined when the code is exhausted or unknown. */
export function spendCoin(input: string, gameId: string): { code: CoinCode; sessionId: string } | undefined {
  const c = findCode(input);
  if (!c || remaining(c) <= 0) return undefined;
  const sessionId = crypto.randomBytes(8).toString("hex");
  c.used += 1;
  c.sessions.push({ id: sessionId, gameId, startedAt: new Date().toISOString() });
  save();
  return { code: c, sessionId };
}

export function closeSession(codeInput: string, sessionId: string, reason: string): void {
  const c = findCode(codeInput);
  const s = c?.sessions.find((x) => x.id === sessionId);
  if (!s || s.endedAt) return;
  s.endedAt = new Date().toISOString();
  s.reason = reason;
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
