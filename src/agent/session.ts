import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { getModels } from "../runtimeConfig.js";
import { isAnthropicModel, isTextModel, relayBaseUrl, relayCatalog, relayKey, RELAY_PROVIDER, type RelayCatalog } from "../relay.js";

const log = logger("pi");

/**
 * pi (https://pi.dev) is the agent harness. This module registers the relay's models as a pi
 * provider, resolves model specs, and builds two kinds of sessions:
 *   - coach: tools-free, JSON-only strategist/commentator that watches the game
 *   - chat : tools-free buyer-conversation drafter for Termix
 * Both go through the relay (RELAY_BASE_URL / RELAY_API_KEY), like 3dcardagent.
 */

function readModelsJson(file: string): { providers?: Record<string, unknown> } {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Every text model on the relay's live catalog is written into <agentDir>/models.json under the
 * `relay` provider: Claude models through the relay's Anthropic Messages endpoint, everything else
 * through OpenAI chat completions. Returns the ids registered.
 */
export function writeRelayModelsJson(catalog: RelayCatalog | undefined): { ids: string[]; changed: boolean } {
  const cfg = getConfig();
  const file = path.join(cfg.agentDir, "models.json");
  const existing = readModelsJson(file);
  const providers = { ...(existing.providers ?? {}) } as Record<string, unknown>;
  const before = JSON.stringify(providers[RELAY_PROVIDER] ?? null);
  const baseUrl = relayBaseUrl();
  const text = (catalog?.models ?? []).filter(isTextModel);
  const models = text.map((m) => {
    const anthropic = isAnthropicModel(m);
    const id = m.id.toLowerCase();
    return {
      id: m.id,
      name: m.id,
      api: anthropic ? "anthropic-messages" : "openai-completions",
      baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`,
      reasoning: anthropic || /gemini-[3-9]|gpt-5|deepseek-v4|glm-5|grok|kimi-k[3-9]|minimax-m|qwen3/.test(id),
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: anthropic ? 200_000 : /gemini/.test(id) ? 1_000_000 : 128_000,
      maxTokens: anthropic ? 32_000 : 16_384,
    };
  });
  const wanted = new Set<string>();
  const current = getModels();
  for (const spec of [current.coachModel, current.chatModel]) {
    const [provider, ...rest] = spec.split("/");
    if (provider === RELAY_PROVIDER && rest.length) wanted.add(rest.join("/").split(":")[0]);
  }
  for (const id of wanted) {
    if (models.some((m) => m.id === id)) continue;
    const anthropic = /^claude/i.test(id);
    models.push({
      id,
      name: id,
      api: anthropic ? "anthropic-messages" : "openai-completions",
      baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: anthropic ? 200_000 : 128_000,
      maxTokens: 16_384,
    });
  }
  providers[RELAY_PROVIDER] = { baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "$RELAY_API_KEY", models };
  const changed = JSON.stringify(providers[RELAY_PROVIDER]) !== before;
  if (changed) {
    fs.mkdirSync(cfg.agentDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...existing, providers }, null, 2));
    log.info(`registered ${models.length} relay models (${baseUrl}) in ${file}`);
  }
  return { ids: models.map((m) => m.id), changed };
}

let runtime: ModelRuntime | undefined;
let lastSyncedCatalogAt = "";

export async function syncRelayModels(opts: { force?: boolean } = {}): Promise<void> {
  const rt = await modelRuntime();
  const catalog = await relayCatalog(opts);
  if (catalog && catalog.fetchedAt === lastSyncedCatalogAt && !opts.force) return;
  lastSyncedCatalogAt = catalog?.fetchedAt ?? "";
  const { changed } = writeRelayModelsJson(catalog);
  if (changed) await rt.refresh();
}

export async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime) return runtime;
  const cfg = getConfig();
  // pi resolves `apiKey: "$RELAY_API_KEY"` from the process environment; .env.local is loaded by getConfig().
  if (relayKey() && !process.env.RELAY_API_KEY) process.env.RELAY_API_KEY = relayKey();
  writeRelayModelsJson(await relayCatalog());
  runtime = await ModelRuntime.create({
    authPath: path.join(cfg.agentDir, "auth.json"),
    modelsPath: path.join(cfg.agentDir, "models.json"),
    modelsStorePath: path.join(cfg.agentDir, "models-store.json"),
  });
  await syncRelayModels().catch((err) => log.warn(`relay model sync failed: ${String(err)}`));
  return runtime;
}

export async function resolveModel(spec: string) {
  const rt = await modelRuntime();
  const r = resolveCliModel({ cliModel: spec, modelRuntime: rt });
  if (r.error || !r.model) throw new Error(`cannot resolve model "${spec}": ${r.error ?? "unknown"}`);
  if (r.warning) log.warn(r.warning);
  return { model: r.model, thinkingLevel: r.thinkingLevel };
}

export function skillFrom(dir: string, source: string): Skill {
  const filePath = path.join(dir, "SKILL.md");
  const head = fs.readFileSync(filePath, "utf8").slice(0, 4000);
  const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? path.basename(dir);
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "";
  return {
    name,
    description,
    filePath,
    baseDir: dir,
    disableModelInvocation: false,
    sourceInfo: { path: filePath, source, scope: "project", origin: "top-level", baseDir: dir },
  } as Skill;
}

export type TextSession = Awaited<ReturnType<typeof createTextSession>>;

/** A tools-free pi session with a fixed system prompt (coach or buyer chat). */
export async function createTextSession(kind: "coach" | "chat", systemPrompt: string, opts: { thinking?: string } = {}) {
  const cfg = getConfig();
  const models = getModels();
  const spec = kind === "coach" ? models.coachModel : models.chatModel;
  const { model, thinkingLevel } = await resolveModel(spec);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const loader = new DefaultResourceLoader({
    cwd: cfg.dataDir,
    agentDir: cfg.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPrompts: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
  } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: cfg.dataDir,
    agentDir: cfg.agentDir,
    model,
    thinkingLevel: (thinkingLevel ?? opts.thinking ?? models.thinking) as never,
    modelRuntime: await modelRuntime(),
    noTools: "all",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cfg.dataDir),
    settingsManager,
  });
  return session;
}

/** Collect the assistant's final text for a prompt. */
export async function promptForText(session: TextSession, prompt: string, images?: Array<{ mediaType: string; data: string }>): Promise<string> {
  let out = "";
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") out += e.assistantMessageEvent.delta;
  });
  try {
    await session.prompt(prompt, { images: images?.map((i) => ({ type: "image" as const, mimeType: i.mediaType, data: i.data })) });
  } finally {
    unsub();
  }
  const err = session.agent.state.errorMessage;
  if (!out.trim() && err) throw new Error(`model error: ${err}`);
  return out.trim();
}

/** Parse the first JSON object in a model reply (models like to wrap it in fences). */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  if (start < 0) return undefined;
  for (let end = fenced.lastIndexOf("}"); end > start; end = fenced.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(fenced.slice(start, end + 1)) as T;
    } catch {
      /* try a shorter slice */
    }
  }
  return undefined;
}
