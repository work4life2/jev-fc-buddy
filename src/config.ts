import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the directory that contains package.json / skills / games / web). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader: never overrides variables already present in the process env. */
export function loadDotEnv(file = path.join(ROOT, ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === "") continue; // a blank placeholder must not shadow a value in a later file
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function envNum(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  root: string;
  dataDir: string;
  skillsDir: string;
  termixSkillDir: string;
  typesafeSkillDir: string;
  gamesDir: string;
  romsDir: string;
  webDir: string;
  agentDir: string;
  /** pi model spec (`provider/model[:thinking]`) for buyer conversations on Termix. */
  llm: { chatModel: string; thinking: string };
  /** OpenAI-compatible relay: RELAY_BASE_URL + RELAY_API_KEY. Default OpenRouter (https://openrouter.ai/api). */
  relay: { baseUrl: string; apiKey: string };
  /**
   * TypeSafe Jev, the System One model that makes the per-tick typed decisions. OpenRouter serves it
   * on the same key at <relay>/v1/systemone, so both default to the relay; TYPESAFE_API_KEY /
   * TYPESAFE_BASE_URL override them for a direct TypeSafe account.
   */
  typesafe: { apiKey: string; model: string; baseUrl: string; viaRelay: boolean; /** USD per million tokens, for the per-coin cost estimate. */ priceInPerM: number; priceOutPerM: number };
  ai: {
    /** How often the browser reports game state (Hz). */
    observeHz: number;
    /** Maximum request rate; the tactical planner also enforces one request in flight. */
    jevHz: number;
  };
  coins: {
    /** Coins minted per 1 unit of order currency (USD/USDC). */
    perDollar: number;
    /** Default minutes of play per coin (the dashboard can override it at runtime). */
    sessionMinutes: number;
    codePrefix: string;
  };
  termix: { chain: string; agentId: string; hasWalletKey: boolean; rpcUrl: string };
  http: {
    port: number;
    host: string;
    /** Public URL of this API server (nginx front). */
    publicBaseUrl: string;
    /** Public URL of the play page (Vercel); equals publicBaseUrl when the server serves web/ itself. */
    playBaseUrl: string;
    adminToken: string;
    adminPath: string;
    allowedOrigins: string[];
  };
  jobs: { sweepIntervalSeconds: number; notifyWebhook: string };
  service: { title: string; price: string; currency: string; deliveryDays: number; category: string; skillTag: string };
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  loadDotEnv(path.join(ROOT, ".env.local")); // secrets (git-ignored), takes precedence
  loadDotEnv();
  const dataDir = path.resolve(ROOT, env("DATA_DIR", "./data"));
  const skillsDir = path.join(ROOT, "skills");
  const port = envNum("HTTP_PORT", 8790);
  const relayBaseUrl = env("RELAY_BASE_URL", "https://openrouter.ai/api").replace(/\/+$/, "").replace(/\/v1$/, "");
  cached = {
    root: ROOT,
    dataDir,
    skillsDir,
    termixSkillDir: path.join(skillsDir, "termix-agent-skills"),
    typesafeSkillDir: path.join(skillsDir, "typesafe-ai"),
    gamesDir: path.join(ROOT, "games"),
    romsDir: path.resolve(ROOT, env("ROMS_DIR", "./roms")),
    webDir: path.join(ROOT, "web"),
    agentDir: path.resolve(ROOT, env("PI_CODING_AGENT_DIR", path.join(dataDir, "pi-agent"))),
    llm: {
      chatModel: env("PI_CHAT_MODEL", env("PI_MODEL", "relay/google/gemini-2.5-flash-lite")),
      thinking: env("PI_THINKING", "off"),
    },
    relay: {
      baseUrl: relayBaseUrl,
      apiKey: env("RELAY_API_KEY"),
    },
    typesafe: {
      apiKey: env("TYPESAFE_API_KEY", env("RELAY_API_KEY")),
      model: env("TYPESAFE_MODEL", "jev-latest"),
      baseUrl: env("TYPESAFE_BASE_URL", relayBaseUrl).replace(/\/+$/, ""),
      viaRelay: !env("TYPESAFE_BASE_URL") && !env("TYPESAFE_API_KEY"),
      priceInPerM: envNum("JEV_PRICE_INPUT_PER_M", 0.042),
      priceOutPerM: envNum("JEV_PRICE_OUTPUT_PER_M", 0.042),
    },
    ai: {
      observeHz: envNum("AI_OBSERVE_HZ", 24),
      jevHz: envNum("AI_JEV_HZ", 4),
    },
    coins: {
      perDollar: envNum("COINS_PER_DOLLAR", 1),
      sessionMinutes: envNum("COIN_SESSION_MINUTES", 30),
      codePrefix: env("COIN_CODE_PREFIX", "FC"),
    },
    termix: {
      chain: env("AACP_CHAIN", "bsc"),
      agentId: env("A2A_AGENT_ID"),
      hasWalletKey: Boolean(env("WALLET_KEY")),
      rpcUrl: env("A2A_RPC_URL"),
    },
    http: {
      port,
      host: env("HTTP_HOST", "0.0.0.0"),
      publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, ""),
      playBaseUrl: env("PLAY_BASE_URL", env("PUBLIC_BASE_URL", `http://localhost:${port}`)).replace(/\/+$/, ""),
      adminToken: env("ADMIN_TOKEN"),
      // Where the operator page is served (default /admin); set a random path in production.
      adminPath: "/" + env("ADMIN_PATH", "/admin").replace(/^\/+|\/+$/g, ""),
      allowedOrigins: env("ALLOWED_ORIGINS")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    },
    jobs: {
      sweepIntervalSeconds: envNum("SWEEP_INTERVAL_SECONDS", 300),
      notifyWebhook: env("NOTIFY_WEBHOOK_URL"),
    },
    service: {
      title: env("SERVICE_TITLE", "AI Co-op Buddy for Classic NES Games (Jev FC Buddy)"),
      price: env("SERVICE_PRICE", "1"),
      currency: env("SERVICE_CURRENCY", "USDC"),
      deliveryDays: envNum("SERVICE_DELIVERY_DAYS", 1),
      category: env("SERVICE_CATEGORY", "Automation & Ops"),
      skillTag: env("SERVICE_SKILL_TAG", "ai-game-buddy"),
    },
  };
  fs.mkdirSync(cached.dataDir, { recursive: true });
  fs.mkdirSync(cached.agentDir, { recursive: true });
  return cached;
}
