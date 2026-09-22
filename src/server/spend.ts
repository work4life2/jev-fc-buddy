import { getConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("spend");

/**
 * What the relay key has spent, straight from OpenRouter's key endpoint (USD). Every model call
 * this service makes (buyer chat and Jev via System One) is billed to that key, so this is
 * the authoritative running cost. Cached for a minute; other relays just report "unavailable".
 */
export interface RelaySpend {
  fetchedAt: string;
  baseUrl: string;
  /** All-time / today / this week / this month, USD. */
  total?: number;
  today?: number;
  week?: number;
  month?: number;
  /** Credits bought and credits left on the account, USD. */
  credits?: number;
  creditsLeft?: number;
  /** Key spending limit, if one is set. */
  limit?: number | null;
  error?: string;
}

const TTL_MS = 60_000;
let cached: RelaySpend | undefined;
let inflight: Promise<RelaySpend> | undefined;

export async function relaySpend(): Promise<RelaySpend> {
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) return cached;
  if (inflight) return inflight;
  const { relay } = getConfig();
  const base: RelaySpend = { fetchedAt: new Date().toISOString(), baseUrl: relay.baseUrl };
  if (!relay.apiKey) return { ...base, error: "RELAY_API_KEY missing" };
  inflight = (async () => {
    try {
      const headers = { authorization: `Bearer ${relay.apiKey}` };
      const [keyRes, creditRes] = await Promise.all([
        fetch(`${relay.baseUrl}/v1/auth/key`, { headers, signal: AbortSignal.timeout(15_000) }),
        fetch(`${relay.baseUrl}/v1/credits`, { headers, signal: AbortSignal.timeout(15_000) }),
      ]);
      if (!keyRes.ok) throw new Error(`auth/key HTTP ${keyRes.status}`);
      const key = ((await keyRes.json()) as { data?: Record<string, unknown> }).data ?? {};
      const credits = creditRes.ok ? (((await creditRes.json()) as { data?: Record<string, unknown> }).data ?? {}) : {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const bought = num(credits.total_credits);
      const usedAll = num(credits.total_usage);
      cached = {
        ...base,
        total: num(key.usage) ?? usedAll,
        today: num(key.usage_daily),
        week: num(key.usage_weekly),
        month: num(key.usage_monthly),
        credits: bought,
        creditsLeft: bought !== undefined && usedAll !== undefined ? Math.max(0, bought - usedAll) : undefined,
        limit: key.limit === null ? null : num(key.limit),
      };
      return cached;
    } catch (err) {
      log.warn(`spend report failed: ${String(err)}`);
      return cached ? { ...cached, error: String(err) } : { ...base, error: String(err) };
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
