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
import { closeSession, findCode, listCodes, mintCode, remaining, spendCoin } from "../coins/store.js";
import { getModels } from "../runtimeConfig.js";
import { dashboardHtml } from "./dashboard.js";

const log = logger("http");

interface PlaySession {
  id: string;
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

function isAdmin(req: http.IncomingMessage): boolean {
  const token = getConfig().http.adminToken;
  const auth = req.headers.authorization ?? "";
  if (token && auth === `Bearer ${token}`) return true;
  return !token && isLoopback(req);
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

function endSession(s: PlaySession, reason: string): void {
  if (s.ended) return;
  s.ended = reason;
  clearTimeout(s.timer);
  s.brain?.stop();
  closeSession(s.code, s.id, reason);
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
    token: s.token,
    game: publicGame(s.game),
    startedAt: new Date(s.startedAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    remaining: code ? remaining(code) : 0,
    ended: s.ended ?? null,
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const cfg = getConfig();
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/health") {
    json(res, 200, { ok: true, games: playableGames().map((g) => g.id), jev: jevEnabled(), coach: getModels().coachModel, sessions: [...sessions.values()].filter((s) => !s.ended).length });
    return;
  }
  if (req.method === "GET" && p === "/api/games") {
    json(res, 200, { games: playableGames().map(publicGame), sessionMinutes: cfg.coins.sessionMinutes, observeHz: cfg.ai.observeHz });
    return;
  }
  if (req.method === "POST" && p === "/api/redeem") {
    const body = await readBody(req);
    const code = findCode(String(body.code ?? ""));
    if (!code) {
      json(res, 404, { error: "unknown code" });
      return;
    }
    json(res, 200, { code: code.code, coins: code.coins, used: code.used, remaining: remaining(code), sessionMinutes: cfg.coins.sessionMinutes });
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
      json(res, 402, { error: "no coins left on this code" });
      return;
    }
    const token = crypto.randomBytes(16).toString("hex");
    const startedAt = Date.now();
    const s: PlaySession = {
      id: spent.sessionId,
      token,
      code: spent.code.code,
      game,
      startedAt,
      expiresAt: startedAt + cfg.coins.sessionMinutes * 60_000,
      lang: String(body.lang ?? "en"),
      timer: setTimeout(() => endSession(s, "time is up"), cfg.coins.sessionMinutes * 60_000),
    };
    sessions.set(token, s);
    log.info(`session ${s.id} started: ${game.id}, code ${spent.code.code} (${remaining(spent.code)} coins left)`);
    json(res, 200, sessionPublic(s));
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
    if (req.method === "GET" && p === "/api/admin/codes") {
      json(res, 200, { codes: listCodes().map((c) => ({ ...c, remaining: remaining(c) })) });
      return;
    }
    if (req.method === "POST" && p === "/api/admin/codes") {
      const body = await readBody(req);
      const rec = mintCode(Number(body.coins ?? 1), { orderId: "local", note: String(body.note ?? "minted by operator") });
      json(res, 200, { code: rec.code, coins: rec.coins, playUrl: `${cfg.http.publicBaseUrl}/?code=${rec.code}` });
      return;
    }
    if (req.method === "GET" && p === "/api/admin/sessions") {
      json(res, 200, { sessions: [...sessions.values()].map(sessionPublic) });
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
  s.brain?.stop();
  s.brain = new BuddyBrain({ game: s.game, lang: s.lang, send });
  ws.on("message", (raw) => {
    let msg: { type?: string; ram?: string; jpeg?: string; lang?: string };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (s.ended) return;
    switch (msg.type) {
      case "obs":
        if (msg.ram) s.brain?.onObservation(Buffer.from(msg.ram, "base64"));
        break;
      case "shot":
        if (msg.jpeg) s.brain?.onScreenshot(msg.jpeg);
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
      s.brain?.stop();
      s.brain = undefined;
    }
  });
}

export function startHttpServer(): http.Server {
  const cfg = getConfig();
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
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (!isAdmin(req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("admin token required (Authorization: Bearer <ADMIN_TOKEN>)");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(dashboardHtml());
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
    log.info(`play page at ${cfg.http.publicBaseUrl}/  (operator dashboard: /admin)`);
  });
  return server;
}
