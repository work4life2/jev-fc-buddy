import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";

/**
 * Models can be switched at runtime without restarting. Overrides live in
 * DATA_DIR/runtime-config.json and win over the .env defaults; every new pi session reads them fresh.
 */
export interface ModelSettings {
  /** pi model for the in-game coach (strategy + commentary), e.g. relay/gemini-2.5-flash-lite */
  coachModel: string;
  /** pi model for buyer chat replies on Termix */
  chatModel: string;
  /** off | minimal | low | medium | high */
  thinking: string;
}

export type ModelKey = keyof ModelSettings;
export const MODEL_KEYS: ModelKey[] = ["coachModel", "chatModel", "thinking"];

function file(): string {
  return path.join(getConfig().dataDir, "runtime-config.json");
}

function readOverrides(): Partial<ModelSettings> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<ModelSettings>;
  } catch {
    return {};
  }
}

export function getModels(): ModelSettings & { overrides: Partial<ModelSettings>; defaults: ModelSettings } {
  const cfg = getConfig();
  const o = readOverrides();
  const defaults: ModelSettings = { coachModel: cfg.llm.coachModel, chatModel: cfg.llm.chatModel, thinking: cfg.llm.thinking };
  return {
    defaults,
    coachModel: o.coachModel || defaults.coachModel,
    chatModel: o.chatModel || defaults.chatModel,
    thinking: o.thinking || defaults.thinking,
    overrides: o,
  };
}

export function setModel(key: ModelKey, value: string | undefined): ModelSettings {
  const o = readOverrides();
  if (value === undefined || value === "") delete o[key];
  else o[key] = value;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(o, null, 2));
  return getModels();
}

export function resetModels(): void {
  try {
    fs.unlinkSync(file());
  } catch {
    /* none */
  }
}
