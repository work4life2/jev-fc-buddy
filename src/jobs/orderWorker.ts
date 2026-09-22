import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getSessionMinutes } from "../runtimeConfig.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type TxIntent } from "../termix/client.js";
import { coinsForPrice, findCodeByOrder, mintCode, type CoinCode } from "../coins/store.js";
import { playableGames } from "../games/registry.js";
import { createJob, findJobByOrder, saveJob, type Job } from "./store.js";
import { postNotice } from "./chat.js";

const log = logger("order");

export interface Order {
  id: string;
  status: string;
  price?: string | number;
  currency?: string;
  amount?: string | number;
  deliveryDueAt?: string;
  challengeWindowEndsAt?: string;
  conversationId?: string;
  latestTxHash?: string;
  buyer?: { id?: string; handle?: string; displayName?: string; walletAddress?: string };
  seller?: { id?: string; agentId?: string; agentTokenId?: string | number };
  providerAgent?: { id?: string };
  providerAgentId?: string;
  offer?: { conversationId?: string; price?: string; currency?: string };
  [k: string]: unknown;
}

/** Is this order sold by the agent we host? Orders of the wallet's other agents are none of our business. */
export function ownsOrder(order: Order): boolean {
  const agentId = getConfig().termix.agentId;
  if (!agentId) return false;
  const seller = (order.seller ?? order.providerAgent ?? {}) as { id?: string; agentId?: string; agentTokenId?: string | number };
  const candidates = [seller.id, seller.agentId, order.providerAgentId].filter(Boolean).map(String);
  if (candidates.includes(agentId)) return true;
  return seller.agentTokenId !== undefined && String(seller.agentTokenId) === agentId;
}

function orderPrice(order: Order): { price: string; currency: string } {
  const price = order.price ?? order.amount ?? order.offer?.price ?? getConfig().service.price;
  const currency = order.currency ?? order.offer?.currency ?? getConfig().service.currency;
  return { price: String(price), currency: String(currency) };
}

function buyerName(order: Order): string | undefined {
  const b = order.buyer ?? {};
  return b.displayName ?? b.handle ?? b.walletAddress ?? b.id;
}

async function getOrder(orderId: string): Promise<Order> {
  const res = await termix().get<Order | { order: Order }>(`/api/v1/orders/${orderId}`);
  return "order" in (res as object) && (res as { order: Order }).order ? (res as { order: Order }).order : (res as Order);
}

async function pollOrder(orderId: string, until: (o: Order) => boolean, timeoutMs = 10 * 60_000): Promise<Order> {
  const end = Date.now() + timeoutMs;
  let last = await getOrder(orderId);
  while (!until(last) && Date.now() < end) {
    await sleep(8000);
    last = await getOrder(orderId);
  }
  return last;
}

function intentFrom(res: unknown): TxIntent {
  const r = res as Record<string, unknown>;
  const candidate = (r.intent ?? r.txIntent ?? r.transaction ?? r) as TxIntent;
  if (!candidate.callData && !candidate.data) throw new Error(`no tx-intent in response: ${JSON.stringify(res).slice(0, 300)}`);
  return candidate;
}

async function acceptOrder(job: Job, order: Order): Promise<Order> {
  if (order.status !== "PENDING_ACCEPT") return order;
  job.status = "accepting";
  saveJob(job);
  log.info(`order ${order.id}: accepting on-chain`);
  const prep = await termix().api("POST", `/api/v1/orders/${order.id}/provider-accept/prepare`, {});
  const tx = await termix().tx(intentFrom(prep), { orderId: order.id });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes.acceptOrder = hash;
  saveJob(job);
  const o = await pollOrder(order.id, (x) => x.status === "FUNDED" || x.status === "IN_PROGRESS");
  if (o.status !== "FUNDED" && o.status !== "IN_PROGRESS") throw new Error(`order ${order.id} did not reach FUNDED/IN_PROGRESS after accept (status ${o.status})`);
  return o;
}

/** The buyer-facing delivery text: the code, the play URL, how it works. */
export function deliveryText(code: CoinCode): string {
  const cfg = getConfig();
  const games = playableGames()
    .map((g) => g.title)
    .join(", ");
  return [
    `🎮 Your AI co-op buddy is ready.`,
    ``,
    `Coin code: ${code.code}`,
    `Coins: ${code.coins} (1 coin = ${getSessionMinutes()} minutes of play; you can leave and come back while the clock runs)`,
    ``,
    `Play here: ${cfg.http.playBaseUrl}/?code=${code.code}`,
    ``,
    `How it works: open the link in a desktop browser, enter the code, pick a game (${games}) and press Insert Coin. You are player 1 (keyboard: WASD or arrows to move, J = fire, K = jump, Enter = start; or plug in any gamepad). The AI is player 2: it follows you, covers you and shoots what threatens you. Every button it presses lights up on the controller shown beside the game (switch to LOG for the text stream).`,
    ``,
    `The code works as many times as it has coins. Keep it private — anyone with the code can spend the coins.`,
  ].join("\n");
}

async function uploadNote(job: Job, text: string): Promise<string> {
  const tx = termix();
  const dir = path.join(getConfig().dataDir, "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "coin-code.txt");
  fs.writeFileSync(file, text);
  const sizeBytes = fs.statSync(file).size;
  const contentType = "text/plain";
  const up = await tx.api<{ uploadUrl: string; s3Key?: string; publicUrl?: string; url?: string; key?: string }>("POST", `/api/v1/orders/${job.orderId}/delivery/upload-url`, {
    fileName: "coin-code.txt",
    contentType,
    sizeBytes,
  });
  const uploaded = await tx.upload(up.uploadUrl, file, contentType);
  const reg = await tx.api<{ id?: string; artifactId?: string; artifact?: { id: string } }>("POST", `/api/v1/orders/${job.orderId}/delivery/artifacts`, {
    s3Key: up.s3Key ?? up.key,
    url: up.publicUrl ?? up.url,
    sha256: uploaded.sha256,
    contentType,
    sizeBytes,
  });
  const artifactId = reg.id ?? reg.artifactId ?? reg.artifact?.id;
  if (!artifactId) throw new Error(`artifact registration returned no id: ${JSON.stringify(reg).slice(0, 300)}`);
  return artifactId;
}

async function deliver(job: Job, code: CoinCode): Promise<void> {
  job.status = "delivering";
  saveJob(job);
  const text = deliveryText(code);
  const artifactId = await uploadNote(job, text);
  job.artifactIds = [artifactId];
  saveJob(job);
  const submit = await termix().api("POST", `/api/v1/orders/${job.orderId}/delivery/submit`, { artifactIds: [artifactId], note: text.slice(0, 3800) });
  const tx = await termix().tx(intentFrom(submit), { orderId: job.orderId });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes.submitDelivery = hash;
  saveJob(job);
  const o = await pollOrder(job.orderId, (x) => x.status === "DELIVERED");
  if (o.status !== "DELIVERED") throw new Error(`order ${job.orderId} not DELIVERED after submit (status ${o.status})`);
  job.status = "delivered";
  saveJob(job);
}

/**
 * Full lifecycle for one funded order: accept → mint a coin code worth the order price → deliver
 * the code + play URL. Idempotent: re-running resumes from the persisted job state, and an order
 * never gets a second code.
 */
export async function processOrder(orderId: string): Promise<Job | undefined> {
  let order = await getOrder(orderId);
  if (!ownsOrder(order)) {
    log.info(`order ${orderId}: sold by another agent, skipping`);
    return undefined;
  }
  const { price, currency } = orderPrice(order);
  let job = findJobByOrder(orderId);
  const convId = order.conversationId ?? order.offer?.conversationId;
  job ??= createJob({ orderId, conversationId: typeof convId === "string" ? convId : undefined, price, currency, buyer: buyerName(order) });
  try {
    if (order.status === "PENDING_ACCEPT") order = await acceptOrder(job, order);
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      log.info(`order ${orderId}: status ${order.status}, nothing to do`);
      return job;
    }
    let code = findCodeByOrder(orderId);
    if (!code) {
      job.status = "minting";
      saveJob(job);
      code = mintCode(coinsForPrice(price), { orderId, buyer: job.buyer, note: `${price} ${currency}` });
      log.info(`order ${orderId}: minted ${code.code} (${code.coins} coins for ${price} ${currency})`);
    }
    job.code = code.code;
    job.coins = code.coins;
    saveJob(job);
    if (job.status !== "delivered" && job.status !== "settled") await deliver(job, code);
    await notify("job.delivered", { orderId, code: code.code, coins: code.coins, tx: job.txHashes });
    if (job.conversationId) {
      await postNotice(job.conversationId, `✅ Delivered! ${deliveryText(code)}`).catch((err) => log.warn(`could not post delivery notice: ${String(err)}`));
    }
    return job;
  } catch (err) {
    job.status = "failed";
    job.error = String(err instanceof Error ? err.message : err);
    saveJob(job);
    log.error(`order ${orderId}: failed — ${job.error}`);
    await notify("job.failed", { orderId, error: job.error });
    throw err;
  }
}

/** Claim escrow for DELIVERED orders whose challenge window has elapsed. */
export async function claimExpiredDeliveries(): Promise<number> {
  const tx = termix();
  const res = await tx.get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider`);
  const items = Array.isArray(res) ? res : (res.items ?? []);
  let claimed = 0;
  for (const o of items) {
    if (!ownsOrder(o) || o.status !== "DELIVERED" || !o.challengeWindowEndsAt) continue;
    if (new Date(o.challengeWindowEndsAt).getTime() > Date.now()) continue;
    try {
      log.info(`order ${o.id}: challenge window elapsed, claiming`);
      const prep = await tx.api("POST", `/api/v1/orders/${o.id}/claim-after-timeout/prepare`, {});
      const r = await tx.tx(intentFrom(prep), { orderId: o.id });
      const job = findJobByOrder(o.id);
      if (job) {
        job.txHashes.claimAfterTimeout = r.results?.[0]?.txHash ?? "";
        job.status = "settled";
        saveJob(job);
      }
      claimed++;
      await notify("order.claimed", { orderId: o.id, tx: r.results?.[0]?.txHash });
    } catch (err) {
      log.warn(`order ${o.id}: claim failed — ${String(err)}`);
    }
  }
  return claimed;
}

/** Sweep provider orders: accept/deliver anything actionable that events may have missed. */
export async function sweepOrders(): Promise<string[]> {
  const tx = termix();
  const res = await tx.get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider`);
  const items = Array.isArray(res) ? res : (res.items ?? []);
  const actionable: string[] = [];
  for (const o of items) {
    if (!ownsOrder(o)) continue;
    const job = findJobByOrder(o.id);
    if (o.status === "PENDING_ACCEPT") actionable.push(o.id);
    else if ((o.status === "FUNDED" || o.status === "IN_PROGRESS") && (!job || !["delivered", "settled", "delivering"].includes(job.status))) actionable.push(o.id);
    else if (o.status === "DELIVERED" && job && !["delivered", "settled"].includes(job.status)) {
      job.status = "delivered";
      job.error = undefined;
      if (typeof o.latestTxHash === "string") job.txHashes.submitDelivery ??= o.latestTxHash;
      saveJob(job);
    } else if (o.status === "SETTLED" && job && job.status !== "settled") {
      job.status = "settled";
      saveJob(job);
    }
  }
  return actionable;
}
