import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * OpenAI-compatible relay (New API / one-api style, e.g. https://www.cun.ai) — the same relay
 * 3dcardagent uses. One key serves OpenAI chat completions and Anthropic messages. This module
 * wraps its live model catalog (`GET /v1/models`, cached briefly, degrades to last-known data).
 */

const log = logger("relay");
const CATALOG_TTL_MS = 10 * 60_000;

/** pi provider id under which every relay model is registered (model ids: `relay/<id>`). */
export const RELAY_PROVIDER = "relay";

export interface RelayModel {
  id: string;
  owned_by?: string;
  supported_endpoint_types?: string[] | null;
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
  if (!key) return undefined;
  const res = await fetch(`${relayBaseUrl()}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
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

/** Image / embedding / audio models are not chat models. */
export function isTextModel(m: RelayModel): boolean {
  const id = m.id.toLowerCase();
  if (/image|embed|tts|whisper|audio|dall-e|sora|veo|rerank|moderation/.test(id)) return false;
  return true;
}

export function isAnthropicModel(m: RelayModel): boolean {
  if (m.supported_endpoint_types?.length) return m.supported_endpoint_types.includes("anthropic") && !m.supported_endpoint_types.includes("openai");
  return /^claude/i.test(m.id);
}

/** Does the relay list a model whose id contains `needle`? (used to answer "is Jev on the relay?") */
export async function relayHasModel(needle: string): Promise<boolean> {
  const c = await relayCatalog();
  return (c?.models ?? []).some((m) => m.id.toLowerCase().includes(needle.toLowerCase()));
}
