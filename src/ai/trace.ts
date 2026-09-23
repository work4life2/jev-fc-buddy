import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";

/** Bounded session traces: enough evidence for attribution without unbounded RAM dumps. */
export function saveDecisionTrace(value: unknown): void {
  const dir = path.join(getConfig().dataDir, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const old = fs.readdirSync(dir).filter(f => /^\d{4}-.*\.json$/.test(f)).sort().slice(0, -64);
  for (const name of old) fs.unlinkSync(path.join(dir, name));
}
