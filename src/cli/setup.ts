import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getSessionMinutes } from "../runtimeConfig.js";
import { termix } from "../termix/client.js";
import { playableGames } from "../games/registry.js";
import { printChecks, runDoctor } from "./doctor.js";

export async function listAgents(): Promise<void> {
  const t = termix();
  const who = (await t.login()) as { wallet?: string; address?: string; handle?: string };
  process.stdout.write(`Wallet: ${who.wallet ?? who.address ?? "?"}${who.handle ? `  @${who.handle}` : ""}  chain: ${getConfig().termix.chain}\n`);
  const res = await t.agents();
  if (!res.items?.length) {
    process.stdout.write('This wallet owns no agents. Run `npm run setup -- mint <name> "<display name>"` to mint one (needs gas).\n');
    return;
  }
  process.stdout.write("Agents you can host:\n");
  for (const a of res.items) process.stdout.write(`  ${a.agentId}  #${a.agentTokenId ?? "-"}  ${a.name}  [${a.a2aStatus ?? "?"}]\n`);
  process.stdout.write("\nPut the chosen agentId into A2A_AGENT_ID in .env.\n");
}

export async function mintAgent(name: string, displayName: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  process.stdout.write(`Minting agent "${name}" (chain ${cfg.termix.chain}; needs gas and a signature)...\n`);
  const prep = await t.api<{ contract: string; callData: string; to?: string }>("POST", "/api/v1/agents/prepare", {
    name,
    displayName,
    category: cfg.service.category,
    description: "An AI teammate that plays classic NES games with you in the browser: it follows, covers and shoots while its moves and commentary stream beside the screen.",
    tags: ["games", "retro", "nes", "co-op", "ai-buddy", "arcade"],
  });
  const tx = await t.tx({ action: "registerAgent", contract: prep.contract ?? prep.to, callData: prep.callData, value: "0" }, { name });
  const hash = tx.results?.[0]?.txHash;
  process.stdout.write(`Broadcast tx ${hash}, waiting for the indexer...\n`);
  for (let i = 0; i < 40; i++) {
    const st = await t.get<{ status?: string }>(`/api/v1/agents/by-tx/${hash}`).catch(() => ({}) as { status?: string });
    if (st.status === "CONFIRMED") {
      process.stdout.write(`✅ Agent registered: ${JSON.stringify(st)}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  process.stdout.write("Not indexed yet; check later with `npm run setup -- agents`.\n");
}

export function listingDescription(): string {
  const cfg = getConfig();
  const games = playableGames()
    .map((g) => g.title)
    .join(", ");
  return `An AI teammate for classic NES co-op games, played in your browser.
Buy coins, get a code, open the play link, insert a coin: you are player 1 (keyboard or any gamepad), the AI is player 2. It follows you, covers you and shoots what threatens you, and every input it makes plus its live commentary scrolls beside the game screen.
• Games right now: ${games || "coming soon"} — more titles are added over time
• ${cfg.coins.perDollar} coin per ${cfg.service.currency}; 1 coin = ${getSessionMinutes()} minutes of play (leave and come back any time while the clock runs); buy N ${cfg.service.currency} to get N coins on one code
• Delivered automatically within minutes of funding: the code and the play link are posted in the order
• Powered by TypeSafe's Jev model for split-second decisions on top of a built-in reflex policy; every move it makes lights up an on-screen controller
Nothing to install. Desktop browser recommended.`;
}

/** Create + publish the service listing (a cover image path is optional). */
export async function publishListing(agentId: string, coverPath?: string, updateId?: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  let coverUrl: string | undefined;
  if (coverPath) {
    const cover = path.resolve(coverPath);
    const size = fs.statSync(cover).size;
    const up = await t.api<{ uploadUrl: string; publicUrl?: string; url?: string }>("POST", "/api/v1/listings/media/upload-url", { fileName: path.basename(cover), contentType: "image/png", sizeBytes: size, purpose: "cover" });
    await t.upload(up.uploadUrl, cover, "image/png");
    coverUrl = up.publicUrl ?? up.url;
  }
  const description = listingDescription();
  const tags = ["games", "retro", "nes", "co-op", "ai-buddy", "arcade", "contra"];
  if (updateId) {
    await t.api("PATCH", `/api/v1/listings/${updateId}`, { title: cfg.service.title, description, tags, basePrice: cfg.service.price, deliveryDays: cfg.service.deliveryDays, ...(coverUrl ? { coverImageUrl: coverUrl, coverImageAlt: "AI co-op buddy" } : {}) });
    process.stdout.write(`✅ Updated listing ${updateId}.\n`);
    return;
  }
  const draft = await t.api<{ id: string }>("POST", `/api/v1/agents/${agentId}/services`, {
    title: cfg.service.title,
    category: cfg.service.category,
    basePrice: cfg.service.price,
    currency: cfg.service.currency,
    deliveryDays: cfg.service.deliveryDays,
    description,
    skillTag: cfg.service.skillTag,
    tags,
    instantBuyable: true,
    publicSearch: true,
    ...(coverUrl ? { coverImageUrl: coverUrl, coverImageAlt: "AI co-op buddy" } : {}),
  });
  process.stdout.write(`Draft created: ${draft.id}\n`);
  await t.api("POST", `/api/v1/listings/${draft.id}/publish`);
  process.stdout.write(`✅ Published listing ${draft.id} (${cfg.service.price} ${cfg.service.currency} per coin, instant-buyable).\n`);
}

export async function fullSetup(): Promise<void> {
  process.stdout.write("== Environment check ==\n");
  printChecks(await runDoctor({ network: true, termix: true }));
  process.stdout.write(`
Next steps:
  1. put RELAY_API_KEY (and TYPESAFE_API_KEY for Jev) into .env.local
  2. npm run code -- mint 3            # a local coin code for testing, then open the play URL it prints
  3. npm run serve -- --local          # play page only (no marketplace)
  --- selling on Termix ---
  4. put WALLET_KEY=0x… (dedicated hot wallet, small gas balance) into .env.local
  5. npm run setup -- agents           # list this wallet's agents → put the id into A2A_AGENT_ID in .env
  6. npm run setup -- listing          # publish the listing
  7. npm start                         # go online: orders → coin codes → delivery
`);
}
