import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * OpenAI-compatible relay. Default: OpenRouter (https://openrouter.ai/api) — one key serves chat
 * completions for every vendor AND TypeSafe's Jev through the System One endpoint
 * (`/v1/systemone`). New API / one-api style relays (e.g. https://www.cun.ai) work too. This
 * module wraps the live model catalog (`GET /v1/models`, cached briefly, degrades to last-known data).
 */

const log = logger("relay");
const CATALOG_TTL_MS = 10 * 60_000;

/** pi provider id under which every relay model is registered (model ids: `relay/<id>`). */
export const RELAY_PROVIDER = "relay";

export interface RelayModel {
  id: string;
  name?: string;
  owned_by?: string;
  /** New API: which upstream protocols the model can be called with ("openai", "anthropic", …). */
  supported_endpoint_types?: string[] | null;
  /** OpenRouter */
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { max_completion_tokens?: number | null };
}

export interface RelayCatalog {
  fetchedAt: string;
  models: RelayModel[];
}

export function relayKey(): string {
  return getConfig().relay.apiKey;
}

export function relayBaseUrl(): string {
  return getConfig().relay.baseUrl;
}

function cacheFile(): string {
  return path.join(getConfig().dataDir, "relay-models.json");
}

let catalogMem: RelayCatalog | undefined;
let inflight: Promise<RelayCatalog | undefined> | undefined;

function readCache(): RelayCatalog | undefined {
  if (catalogMem) return catalogMem;
  try {
    catalogMem = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as RelayCatalog;
  } catch {
    /* none */
  }
  return catalogMem;
}

async function fetchCatalog(): Promise<RelayCatalog | undefined> {
  const key = relayKey();
  if (!key && !isOpenRouter()) return undefined; // OpenRouter's catalog is public; New API relays need the key
  const res = await fetch(`${relayBaseUrl()}/v1/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
  const body = (await res.json()) as { data?: RelayModel[] };
  const catalog: RelayCatalog = { fetchedAt: new Date().toISOString(), models: body.data ?? [] };
  catalogMem = catalog;
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(catalog, null, 2));
  } catch {
    /* ignore */
  }
  return catalog;
}

/** Live catalog (cached 10 min); falls back to the on-disk copy when the relay is unreachable. */
export async function relayCatalog(opts: { force?: boolean } = {}): Promise<RelayCatalog | undefined> {
  const cached = readCache();
  if (!opts.force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < CATALOG_TTL_MS) return cached;
  inflight ??= fetchCatalog()
    .catch((err) => {
      log.warn(`catalog fetch failed: ${String(err)}`);
      return cached;
    })
    .finally(() => (inflight = undefined));
  return inflight;
}

/** Image / embedding / audio / batch / System One entries are not chat models. */
export function isTextModel(m: RelayModel): boolean {
  const id = m.id.toLowerCase();
  if (id.endsWith(":batch") || id.includes("typesafe/") || /\bjev\b/.test(id)) return false;
  if (m.architecture?.output_modalities) return m.architecture.output_modalities.includes("text");
  if (/image|embed|tts|whisper|audio|dall-e|sora|veo|rerank|moderation/.test(id)) return false;
  return true;
}

export function acceptsImages(m: RelayModel): boolean {
  return m.architecture?.input_modalities ? m.architecture.input_modalities.includes("image") : true;
}

/** $/token → $/M token as pi expects; 0 when the relay publishes no prices. */
export function modelCost(m: RelayModel): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const input = Number(m.pricing?.prompt ?? 0) * 1e6;
  const output = Number(m.pricing?.completion ?? 0) * 1e6;
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0, cacheRead: 0, cacheWrite: 0 };
}

export function isOpenRouter(): boolean {
  return /openrouter\.ai/i.test(relayBaseUrl());
}

/** Models that must be called through the relay's Anthropic Messages endpoint (New API only; OpenRouter speaks OpenAI for all). */
export function isAnthropicModel(m: RelayModel): boolean {
  if (isOpenRouter()) return false;
  if (m.supported_endpoint_types?.length) return m.supported_endpoint_types.includes("anthropic") && !m.supported_endpoint_types.includes("openai");
  return /^claude/i.test(m.id);
}

/** Does the relay list a model whose id contains `needle`? (used to answer "is Jev on the relay?") */
export async function relayHasModel(needle: string): Promise<boolean> {
  const c = await relayCatalog();
  return (c?.models ?? []).some((m) => m.id.toLowerCase().includes(needle.toLowerCase()));
}
