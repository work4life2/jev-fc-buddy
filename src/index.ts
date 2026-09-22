#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig, ROOT } from "./config.js";
import { initLogFile, logger } from "./log.js";

const log = logger("main");

function usage(): never {
  process.stdout.write(`jev-fc-buddy — an AI co-op buddy for classic NES games, sold as coin codes on Termix

Usage:
  jev-fc-buddy serve [--local]        start the play server; without --local also host the Termix agent (orders → codes)
  jev-fc-buddy code mint <coins> [note]   mint a coin code locally (testing / manual sales); prints the play URL
  jev-fc-buddy code list              list codes and their balances
  jev-fc-buddy setup [agents|mint <name> "<display name>"|listing [cover.png] [--update <listingId>]]
  jev-fc-buddy model [show|list [filter] [--refresh]|coach <id>|chat <id>|thinking <lvl>|reset]
  jev-fc-buddy doctor [--no-network]  check environment and configuration
  jev-fc-buddy jobs                   list Termix orders handled
  jev-fc-buddy pi [args...]           interactive pi with the termix + typesafe skills loaded
`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = getConfig();
  initLogFile(path.join(cfg.dataDir, "logs"));

  switch (cmd) {
    case "serve": {
      const local = rest.includes("--local") || !cfg.termix.agentId || !cfg.termix.hasWalletKey;
      const { startHttpServer } = await import("./server/http.js");
      const { runDoctor, printChecks } = await import("./cli/doctor.js");
      const checks = await runDoctor({ network: !rest.includes("--no-network"), termix: !local });
      if (!printChecks(checks)) {
        log.error("fix the ❌ items above before serving");
        process.exit(1);
      }
      const server = startHttpServer();
      if (local) {
        log.info(rest.includes("--local") ? "local mode: play server only, Termix hosting off" : "A2A_AGENT_ID / WALLET_KEY not set: play server only (mint codes with `npm run code -- mint 3`)");
        const stop = () => {
          log.info("bye");
          server.close();
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return;
      }
      const { HostingLoop } = await import("./hosting/loop.js");
      const loop = new HostingLoop(cfg.termix.agentId);
      const stop = () => {
        log.info("shutting down after current work...");
        loop.stop();
        server.close();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await loop.run();
      break;
    }
    case "code": {
      const { mintCode, listCodes, remaining } = await import("./coins/store.js");
      const { getSessionMinutes } = await import("./runtimeConfig.js");
      const sub = rest[0];
      if (sub === "mint") {
        const coins = Number(rest[1] ?? 1);
        const rec = mintCode(coins, { orderId: "local", note: rest.slice(2).join(" ") || "minted by operator" });
        process.stdout.write(`✅ ${rec.code}  (${rec.coins} coin${rec.coins > 1 ? "s" : ""}, ${getSessionMinutes()} min each)\n   play: ${cfg.http.playBaseUrl}/?code=${rec.code}\n`);
      } else if (sub === "list" || !sub) {
        for (const c of listCodes()) process.stdout.write(`${c.code}  ${String(remaining(c)).padStart(3)}/${String(c.coins).padEnd(3)} left  ${c.orderId.padEnd(28)} ${c.createdAt.slice(0, 16)}  ${c.note ?? ""}\n`);
      } else usage();
      break;
    }
    case "setup": {
      const { fullSetup, listAgents, mintAgent, publishListing } = await import("./cli/setup.js");
      const sub = rest[0];
      if (!sub) await fullSetup();
      else if (sub === "agents") await listAgents();
      else if (sub === "mint" && rest[1]) await mintAgent(rest[1], rest[2] ?? rest[1]);
      else if (sub === "listing") {
        if (!cfg.termix.agentId) throw new Error("A2A_AGENT_ID is not set (npm run setup -- agents)");
        const upd = rest.indexOf("--update");
        const updateId = upd >= 0 ? rest[upd + 1] : undefined;
        const cover = rest.slice(1).find((a) => a.endsWith(".png"));
        await publishListing(cfg.termix.agentId, cover, updateId);
      } else usage();
      break;
    }
    case "doctor": {
      const { runDoctor, printChecks } = await import("./cli/doctor.js");
      const ok = printChecks(await runDoctor({ network: !rest.includes("--no-network"), termix: true }));
      process.exit(ok ? 0 : 1);
    }
    case "model": {
      const { getModels, setModel, resetModels, MODEL_KEYS } = await import("./runtimeConfig.js");
      const sub = rest[0] ?? "show";
      const map: Record<string, (typeof MODEL_KEYS)[number]> = { coach: "coachModel", chat: "chatModel", thinking: "thinking" };
      if (sub === "show") {
        const m = getModels();
        process.stdout.write(`coach    ${m.coachModel}${m.overrides.coachModel ? "" : "  (env default)"}\nchat     ${m.chatModel}${m.overrides.chatModel ? "" : "  (env default)"}\nthinking ${m.thinking}${m.overrides.thinking ? "" : "  (env default)"}\njev      ${cfg.typesafe.model} (${cfg.typesafe.apiKey ? "TypeSafe key set" : "no TYPESAFE_API_KEY"})\n`);
      } else if (sub === "reset") {
        resetModels();
        process.stdout.write("Reset to the .env defaults\n");
      } else if (sub === "list") {
        const { relayCatalog, isTextModel } = await import("./relay.js");
        const { syncRelayModels } = await import("./agent/session.js");
        const catalog = await relayCatalog({ force: rest.includes("--refresh") });
        await syncRelayModels().catch(() => undefined);
        const filter = rest.slice(1).find((a) => !a.startsWith("--"))?.toLowerCase();
        if (!catalog) process.stdout.write("Relay catalog unavailable (RELAY_API_KEY missing or offline)\n");
        else {
          process.stdout.write(`Relay catalog fetched ${catalog.fetchedAt} (${cfg.relay.baseUrl})\n`);
          for (const m of catalog.models.filter(isTextModel)) if (!filter || m.id.toLowerCase().includes(filter)) process.stdout.write(`  relay/${m.id}\n`);
        }
      } else if (map[sub] && rest[1]) {
        if (sub !== "thinking") {
          const { resolveModel } = await import("./agent/session.js");
          await resolveModel(rest[1]);
        }
        const m = setModel(map[sub], rest[1]);
        process.stdout.write(`✅ ${sub} → ${m[map[sub]]} (applies to new sessions immediately)\n`);
      } else usage();
      break;
    }
    case "jobs": {
      const { listJobs } = await import("./jobs/store.js");
      for (const j of listJobs()) process.stdout.write(`${j.id.padEnd(40)} ${j.status.padEnd(11)} ${j.code ?? "-"}  ${j.updatedAt}${j.error ? "  ✗ " + j.error.slice(0, 80) : ""}\n`);
      break;
    }
    case "pi": {
      const bin = path.join(ROOT, "node_modules", ".bin", "pi");
      if (!fs.existsSync(bin)) throw new Error("pi is not installed; run npm install");
      const { modelRuntime } = await import("./agent/session.js");
      await modelRuntime(); // registers the relay models in <agentDir>/models.json
      const env = { ...process.env, PI_CODING_AGENT_DIR: cfg.agentDir, RELAY_API_KEY: cfg.relay.apiKey };
      const args = rest.some((a) => a === "--approve" || a === "-a" || a === "--no-approve" || a === "-na") ? rest : ["--approve", ...rest];
      const child = spawn(bin, args, { cwd: ROOT, stdio: "inherit", env });
      child.on("exit", (c) => process.exit(c ?? 0));
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  log.error(String(err instanceof Error ? (err.stack ?? err.message) : err));
  process.exit(1);
});
