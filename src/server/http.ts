import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { BuddyBrain, type BuddyMessage } from "../ai/player.js";
import { jevEnabled } from "../ai/jev.js";
import { getGame, playableGames, publicGame, romPath, type GameProfile } from "../games/registry.js";
import { activeWindow, addWindowUsage, closeSession, findCode, listCodes, mintCode, remaining, spendCoin, type CoinWindow } from "../coins/store.js";
import { listJobs } from "../jobs/store.js";
import { getModels, getSessionMinutes, setSessionMinutes } from "../runtimeConfig.js";
import { dashboardHtml } from "./dashboard.js";
import { relaySpend } from "./spend.js";

const log = logger("http");

interface PlaySession {
  id: string;
  /** The coin window this browser session belongs to (one window can be re-entered several times). */
  windowId: string;
  token: string;
  code: string;
  game: GameProfile;
  startedAt: number;
  expiresAt: number;
  lang: string;
  brain?: BuddyBrain;
  ws?: WebSocket;
  timer: NodeJS.Timeout;
  ended?: string;
}

const sessions = new Map<string, PlaySession>();
/** Sessions this process has opened since start (for the dashboard). */
let sessionsOpened = 0;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** Operator check: the bearer token; without a configured token only loopback callers (never behind nginx). */
function isAdmin(req: http.IncomingMessage): boolean {
  const token = getConfig().http.adminToken;
  const auth = req.headers.authorization ?? "";
  if (token) {
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return isLoopback(req);
}

function serveStatic(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600" });
    res.end(data);
  });
}

/** Stop a session's brain and book what it consumed on the coin window. */
function stopBrain(s: PlaySession): void {
  if (!s.brain) return;
  const u = s.brain.usage();
  s.brain.stop();
  s.brain = undefined;
  addWindowUsage(s.code, s.windowId, u);
}

function endSession(s: PlaySession, reason: string): void {
  if (s.ended) return;
  s.ended = reason;
  clearTimeout(s.timer);
  stopBrain(s);
  // A takeover only replaces the browser session; the coin window itself keeps running untouched.
  if (reason !== "resumed in another tab") closeSession(s.code, s.windowId, reason);
  try {
    s.ws?.send(JSON.stringify({ type: "expired", reason }));
  } catch {
    /* gone */
  }
  log.info(`session ${s.id} ended (${reason})`);
  setTimeout(() => sessions.delete(s.token), 60_000).unref();
}

function sessionPublic(s: PlaySession) {
  const code = findCode(s.code);
  return {
    sessionId: s.id,
    windowId: s.windowId,
    token: s.token,
    game: { ...publicGame(s.game), controlProfile: { ...s.game, rom: "", romSha256: undefined } },
    startedAt: new Date(s.startedAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    remaining: code ? remaining(code) : 0,
    ended: s.ended ?? null,
  };
}

/** What the play page needs to know about a code: balance plus the window that is still running. */
function codePublic(code: NonNullable<ReturnType<typeof findCode>>) {
  const running = activeWindow(code);
  return {
    code: code.code,
    coins: code.coins,
    used: code.used,
    remaining: remaining(code),
    sessionMinutes: getSessionMinutes(),
    active: running ? { gameId: running.gameId, expiresAt: running.expiresAt, secondsLeft: Math.max(0, Math.round((Date.parse(running.expiresAt!) - Date.now()) / 1000)) } : null,
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const cfg = getConfig();
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/health") {
    json(res, 200, { ok: true, games: playableGames().map((g) => g.id), jev: jevEnabled(), sessions: [...sessions.values()].filter((s) => !s.ended).length });
    return;
  }
  if (req.method === "GET" && p === "/api/games") {
    json(res, 200, { games: playableGames().map(publicGame), sessionMinutes: getSessionMinutes(), observeHz: cfg.ai.observeHz });
    return;
  }
  if (req.method === "POST" && p === "/api/redeem") {
    const body = await readBody(req);
    const code = findCode(String(body.code ?? ""));
    if (!code) {
      json(res, 404, { error: "unknown code" });
      return;
    }
    json(res, 200, codePublic(code));
    return;
  }
  if (req.method === "POST" && p === "/api/sessions") {
    const body = await readBody(req);
    const game = getGame(String(body.gameId ?? ""));
    if (!game || !playableGames().includes(game)) {
      json(res, 400, { error: "unknown or unavailable game" });
      return;
    }
    const spent = spendCoin(String(body.code ?? ""), game.id);
    if (!spent) {
      json(res, 402, { error: findCode(String(body.code ?? "")) ? "no coins left on this code" : "unknown code" });
      return;
    }
    // One window, one live browser session: a second tab (or a second person with the code) takes over.
    for (const other of sessions.values()) if (!other.ended && other.windowId === spent.window.id) endSession(other, "resumed in another tab");
    const token = crypto.randomBytes(16).toString("hex");
    const startedAt = Date.now();
    const expiresAt = Date.parse(spent.window.expiresAt!);
    const s: PlaySession = {
      id: crypto.randomBytes(8).toString("hex"),
      windowId: spent.window.id,
      token,
      code: spent.code.code,
      game,
      startedAt,
      expiresAt,
      lang: String(body.lang ?? "en"),
      timer: setTimeout(() => endSession(s, "time is up"), Math.max(1000, expiresAt - startedAt)),
    };
    sessions.set(token, s);
    sessionsOpened++;
    log.info(`session ${s.id} ${spent.resumed ? "resumed" : "started"}: ${game.id}, code ${spent.code.code}, window ${spent.window.id} until ${spent.window.expiresAt} (${remaining(spent.code)} coins left)`);
    json(res, 200, { ...sessionPublic(s), resumed: spent.resumed });
    return;
  }
  const m = /^\/api\/sessions\/([a-f0-9]+)(?:\/(end))?$/.exec(p);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) {
      json(res, 404, { error: "no such session" });
      return;
    }
    if (req.method === "POST" && m[2] === "end") endSession(s, "player quit");
    json(res, 200, sessionPublic(s));
    return;
  }
  const rom = /^\/api\/games\/([a-z0-9_-]+)\/rom$/.exec(p);
  if (req.method === "GET" && rom) {
    const s = sessions.get(url.searchParams.get("token") ?? "");
    if (!s || s.ended || s.game.id !== rom[1]) {
      json(res, 403, { error: "a live session is required to load the ROM" });
      return;
    }
    const file = romPath(s.game);
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // ── operator ──
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(req)) {
      json(res, 401, { error: "admin token required" });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/overview") {
      const codes = listCodes();
      const jobs = listJobs();
      const now = Date.now();
      const dayAgo = now - 86_400_000;
      const paid = jobs.filter((j) => j.status === "delivered" || j.status === "settled");
      const revenue = paid.reduce((a, j) => a + (Number(j.price) || 0), 0);
      const windows = codes.flatMap((c) => c.sessions.map((w) => ({ ...w, code: c.code })));
      const measured = windows.filter((w) => w.usage && (w.usage.jevCalls > 0 || w.usage.playSeconds > 0));
      const sum = (f: (u: NonNullable<CoinWindow["usage"]>) => number) => measured.reduce((a, w) => a + f(w.usage!), 0);
      const playSeconds = sum((u) => u.playSeconds);
      const estCost = sum((u) => u.estCost);
      const spend = await relaySpend();
      json(res, 200, {
        now: new Date(now).toISOString(),
        spend,
        perCoin: {
          measuredCoins: measured.length,
          playSeconds,
          jevCalls: sum((u) => u.jevCalls),
          inputTokens: sum((u) => u.inputTokens),
          outputTokens: sum((u) => u.outputTokens),
          estCost,
          avgCostPerCoin: measured.length ? estCost / measured.length : null,
          avgCostPerPlayMinute: playSeconds ? estCost / (playSeconds / 60) : null,
          avgPlayMinutes: measured.length ? playSeconds / 60 / measured.length : null,
          avgJevCallsPerMinute: playSeconds ? sum((u) => u.jevCalls) / (playSeconds / 60) : null,
          /** Sanity check from the bill: everything the key spent divided by every coin ever inserted. */
          keySpendPerCoinUsed: spend.total !== undefined && codes.reduce((a, c) => a + c.used, 0) > 0 ? spend.total / codes.reduce((a, c) => a + c.used, 0) : null,
          priceInPerM: cfg.typesafe.priceInPerM,
          priceOutPerM: cfg.typesafe.priceOutPerM,
        },
        settings: { sessionMinutes: getSessionMinutes(), defaultSessionMinutes: cfg.coins.sessionMinutes, coinsPerDollar: cfg.coins.perDollar, price: cfg.service.price, currency: cfg.service.currency },
        models: { chat: getModels().chatModel, jev: jevEnabled() ? cfg.typesafe.model : null, relay: cfg.relay.baseUrl },
        games: playableGames().map((g) => g.id),
        hosting: { enabled: Boolean(cfg.termix.agentId && cfg.termix.hasWalletKey), agentId: cfg.termix.agentId || null, chain: cfg.termix.chain },
        urls: { api: cfg.http.publicBaseUrl, play: cfg.http.playBaseUrl },
        coins: {
          codes: codes.length,
          minted: codes.reduce((a, c) => a + c.coins, 0),
          used: codes.reduce((a, c) => a + c.used, 0),
          usedToday: windows.filter((w) => Date.parse(w.startedAt) > dayAgo).length,
          activeWindows: windows.filter((w) => w.expiresAt && w.reason !== "time is up" && Date.parse(w.expiresAt) > now).length,
        },
        orders: { total: jobs.length, paid: paid.length, failed: jobs.filter((j) => j.status === "failed").length, revenue, currency: cfg.service.currency },
        sessions: { live: [...sessions.values()].filter((s) => !s.ended).length, openedSinceStart: sessionsOpened },
      });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/settings") {
      json(res, 200, { sessionMinutes: getSessionMinutes(), defaultSessionMinutes: cfg.coins.sessionMinutes });
      return;
    }
    if (req.method === "POST" && p === "/api/admin/settings") {
      const body = await readBody(req);
      if ("sessionMinutes" in body) {
        const v = body.sessionMinutes === null || body.sessionMinutes === "" ? undefined : Number(body.sessionMinutes);
        if (v !== undefined && (!Number.isFinite(v) || v < 1 || v > 24 * 60)) {
          json(res, 400, { error: "sessionMinutes must be between 1 and 1440" });
          return;
        }
        const minutes = setSessionMinutes(v);
        log.info(`operator set session minutes to ${minutes}${v === undefined ? " (env default)" : ""}`);
      }
      json(res, 200, { sessionMinutes: getSessionMinutes(), defaultSessionMinutes: cfg.coins.sessionMinutes });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/codes") {
      json(res, 200, { codes: listCodes().map((c) => ({ ...c, remaining: remaining(c), active: activeWindow(c)?.expiresAt ?? null })) });
      return;
    }
    if (req.method === "POST" && p === "/api/admin/codes") {
      const body = await readBody(req);
      const rec = mintCode(Number(body.coins ?? 1), { orderId: "local", note: String(body.note ?? "minted by operator") });
      json(res, 200, { code: rec.code, coins: rec.coins, playUrl: `${cfg.http.playBaseUrl}/?code=${rec.code}` });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/sessions") {
      json(res, 200, { sessions: [...sessions.values()].map(sessionPublic) });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/windows") {
      const rows = listCodes()
        .flatMap((c) => c.sessions.map((w) => ({ code: c.code, orderId: c.orderId, ...w })))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 200);
      json(res, 200, { windows: rows });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/orders") {
      json(res, 200, { orders: listJobs().slice(0, 200) });
      return;
    }
  }
  json(res, 404, { error: "not found" });
}

function attachWs(s: PlaySession, ws: WebSocket): void {
  s.ws?.close();
  s.ws = ws;
  const send = (m: BuddyMessage | Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send({ type: "session", ...sessionPublic(s) });
  stopBrain(s);
  s.brain = new BuddyBrain({ game: s.game, send });
  ws.on("message", (raw) => {
    let msg: { type?: string; ram?: string; lang?: string; frame?: number; epoch?: number; forecast?: unknown; execution?: unknown };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (s.ended) return;
    switch (msg.type) {
      case "obs":
        if (msg.forecast) s.brain?.onForecast(msg.forecast);
        if (msg.execution) s.brain?.onExecutionReport(msg.execution);
        if (typeof msg.ram === "string") s.brain?.onObservation(Buffer.from(msg.ram, "base64"), Number.isSafeInteger(msg.frame) && msg.frame! >= 0 ? msg.frame : undefined, Number.isSafeInteger(msg.epoch) && msg.epoch! >= 0 ? msg.epoch : undefined);
        break;
      case "hello":
        if (msg.lang) s.lang = msg.lang;
        break;
      case "quit":
        endSession(s, "player quit");
        break;
    }
  });
  ws.on("close", () => {
    if (s.ws === ws) {
      s.ws = undefined;
      stopBrain(s);
    }
  });
}

export function startHttpServer(): http.Server {
  const cfg = getConfig();
  // The play page is hosted elsewhere (Vercel) when PLAY_BASE_URL differs: this server is then API + WebSocket only.
  const pageOffOrigin = cfg.http.playBaseUrl !== cfg.http.publicBaseUrl;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/")) {
      // The play page may be hosted on another origin (Vercel): allow the listed ones.
      const origin = req.headers.origin ?? "";
      if (origin && cfg.http.allowedOrigins.includes(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, authorization");
        res.setHeader("access-control-max-age", "86400");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      handleApi(req, res, url).catch((err) => {
        log.error(`api ${url.pathname}: ${String(err)}`);
        json(res, 500, { error: "internal error" });
      });
      return;
    }
    if (url.pathname === cfg.http.adminPath || url.pathname === cfg.http.adminPath + "/") {
      // The page itself carries no secrets: it asks for the token and sends it as a bearer to /api/admin/*.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
      res.end(dashboardHtml());
      return;
    }
    if (pageOffOrigin) {
      if (url.pathname === "/" || url.pathname === "/play" || url.pathname === "/index.html") {
        res.writeHead(302, { location: `${cfg.http.playBaseUrl}/${url.search}`, "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let rel = url.pathname === "/" || url.pathname === "/play" ? "/index.html" : url.pathname;
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(cfg.webDir, rel);
    if (!file.startsWith(cfg.webDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    serveStatic(res, file);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const s = sessions.get(url.searchParams.get("token") ?? "");
    if (!s || s.ended) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachWs(s, ws));
  });

  server.listen(cfg.http.port, cfg.http.host, () => {
    log.info(`api at ${cfg.http.publicBaseUrl}/  play page: ${cfg.http.playBaseUrl}/${pageOffOrigin ? " (off-origin)" : ""}  operator dashboard: ${cfg.http.adminPath}`);
  });
  return server;
}
