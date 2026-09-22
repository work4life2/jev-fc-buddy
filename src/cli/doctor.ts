import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { modelRuntime, resolveModel } from "../agent/session.js";
import { jevEnabled, jevPing } from "../ai/jev.js";
import { listGames, romAvailable } from "../games/registry.js";
import { getModels } from "../runtimeConfig.js";
import { termix } from "../termix/client.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

export async function runDoctor(opts: { network?: boolean; termix?: boolean } = { network: true, termix: true }): Promise<Check[]> {
  const cfg = getConfig();
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = true) => checks.push({ name, ok, detail, fatal });

  const node = process.versions.node;
  add("node", Number(node.split(".")[0]) >= 22, `v${node}`);
  add("web client", fs.existsSync(path.join(cfg.webDir, "vendor", "jsnes.min.js")), fs.existsSync(path.join(cfg.webDir, "vendor", "jsnes.min.js")) ? "jsnes bundled" : "run `npm run build` (copies jsnes into web/vendor)");
  add("skill: termix-agent-skills", fs.existsSync(path.join(cfg.termixSkillDir, "SKILL.md")), cfg.termixSkillDir);
  add("skill: typesafe-ai", fs.existsSync(path.join(cfg.typesafeSkillDir, "SKILL.md")), cfg.typesafeSkillDir);

  const games = listGames();
  add("games", games.length > 0, games.map((g) => `${g.id}${romAvailable(g) ? "" : " (ROM missing)"}`).join(", ") || "none in games/");
  for (const g of games) add(`rom: ${g.id}`, romAvailable(g), romAvailable(g) ? path.join(cfg.romsDir, g.rom) : `put ${g.rom} into ${cfg.romsDir}/`, false);

  add("relay key", Boolean(cfg.relay.apiKey), cfg.relay.apiKey ? cfg.relay.baseUrl : "RELAY_API_KEY not set (.env.local): Jev and buyer chat are off until it is", false);
  try {
    const rt = await modelRuntime();
    const models = getModels();
    for (const [label, spec] of [["chat model", models.chatModel]] as const) {
      const { model } = await resolveModel(spec);
      // pi answers {type:"api_key", source:"…"} when credentials are configured, an error field otherwise.
      const auth = (await rt.checkAuth(model.provider).catch(() => undefined)) as { type?: string; source?: string; error?: string; available?: boolean } | boolean | undefined;
      const ok = typeof auth === "object" && auth !== null ? Boolean(auth.type || auth.available) && !auth.error : Boolean(auth);
      add(label, ok, `${model.provider}/${model.id}${ok ? ` (${(auth as { source?: string }).source ?? "ok"})` : " — no credentials (RELAY_API_KEY)"}`, false);
    }
  } catch (err) {
    add("pi models", false, String(err instanceof Error ? err.message : err), false);
  }

  const jevWhere = cfg.typesafe.viaRelay ? `via relay ${cfg.typesafe.baseUrl}/v1/systemone` : `direct ${cfg.typesafe.baseUrl}`;
  if (jevEnabled()) {
    const p = opts.network === false ? { ok: true, model: "(not probed)" } : await jevPing();
    add("jev (System One)", p.ok, p.ok ? `${cfg.typesafe.model} → ${p.model} (${jevWhere})` : `${jevWhere} rejected: ${p.error?.slice(0, 160)}`, false);
  } else {
    add("jev (System One)", false, "no key — set RELAY_API_KEY (OpenRouter serves Jev) or TYPESAFE_API_KEY; the buddy plays on the reflex policy only", false);
  }

  if (opts.termix !== false && opts.network !== false) {
    const t = termix();
    add("termix wallet", cfg.termix.hasWalletKey, cfg.termix.hasWalletKey ? `key mode, chain ${cfg.termix.chain}` : "WALLET_KEY not set — needed only to sell on Termix (npm start); local play works without it", false);
    if (cfg.termix.hasWalletKey) {
      const login = await t.login().catch((e) => ({ error: String(e) }));
      const l = login as { wallet?: string; address?: string; handle?: string; error?: string };
      add("termix login", !l.error, l.error ? (l.error.split("\n").pop() ?? "failed") : `wallet ${l.wallet ?? l.address ?? ""} ${l.handle ? "@" + l.handle : ""}`.trim(), false);
    }
    add("termix agent", Boolean(cfg.termix.agentId), cfg.termix.agentId || "A2A_AGENT_ID not set — run `npm run setup -- agents`", false);
  }
  return checks;
}

export function printChecks(checks: Check[]): boolean {
  let ok = true;
  for (const c of checks) {
    const mark = c.ok ? "✅" : c.fatal ? "❌" : "⚠️ ";
    if (!c.ok && c.fatal) ok = false;
    process.stdout.write(`${mark} ${c.name.padEnd(26)} ${c.detail}\n`);
  }
  return ok;
}
