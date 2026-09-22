import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";

/**
 * Settings that can be changed at runtime without restarting (models, the coin window length).
 * Overrides live in DATA_DIR/runtime-config.json and win over the .env defaults; every new pi
 * session and every new coin window reads them fresh.
 */
export interface ModelSettings {
  /** pi model for buyer chat replies on Termix, e.g. relay/google/gemini-2.5-flash-lite */
  chatModel: string;
  /** off | minimal | low | medium | high */
  thinking: string;
}

export type ModelKey = keyof ModelSettings;
export const MODEL_KEYS: ModelKey[] = ["chatModel", "thinking"];

interface Overrides extends Partial<ModelSettings> {
  /** Minutes of play one coin buys (operator dashboard). */
  sessionMinutes?: number;
}

function file(): string {
  return path.join(getConfig().dataDir, "runtime-config.json");
}

function readOverrides(): Overrides {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Overrides;
  } catch {
    return {};
  }
}

function writeOverrides(o: Overrides): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(o, null, 2));
}

export function getModels(): ModelSettings & { overrides: Partial<ModelSettings>; defaults: ModelSettings } {
  const cfg = getConfig();
  const o = readOverrides();
  const defaults: ModelSettings = { chatModel: cfg.llm.chatModel, thinking: cfg.llm.thinking };
  return {
    defaults,
    chatModel: o.chatModel || defaults.chatModel,
    thinking: o.thinking || defaults.thinking,
    overrides: { chatModel: o.chatModel, thinking: o.thinking },
  };
}

export function setModel(key: ModelKey, value: string | undefined): ModelSettings {
  const o = readOverrides();
  if (value === undefined || value === "") delete o[key];
  else o[key] = value;
  writeOverrides(o);
  return getModels();
}

export function resetModels(): void {
  const o = readOverrides();
  for (const k of MODEL_KEYS) delete o[k];
  writeOverrides(o);
}

/** Minutes of play per coin: the dashboard override, else COIN_SESSION_MINUTES. */
export function getSessionMinutes(): number {
  const o = readOverrides();
  const n = Number(o.sessionMinutes);
  return Number.isFinite(n) && n > 0 ? n : getConfig().coins.sessionMinutes;
}

export function setSessionMinutes(minutes: number | undefined): number {
  const o = readOverrides();
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) delete o.sessionMinutes;
  else o.sessionMinutes = Math.round(minutes * 100) / 100;
  writeOverrides(o);
  return getSessionMinutes();
}
