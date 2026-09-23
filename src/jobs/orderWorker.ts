import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getSessionMinutes } from "../runtimeConfig.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type RemoteConversation, type TxIntent } from "../termix/client.js";
import { codesForOrder, coinsForPrice, findCodeByOrder, isUsed, mintCode, revokeCode, type CoinCode } from "../coins/store.js";
import { playableGames } from "../games/registry.js";
import { createJob, findJobByOrder, loadConversation, saveJob, type Job } from "./store.js";
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
  /** Set once the buyer spent their single redo (order back to IN_PROGRESS). */
  redoUsed?: boolean;
  redoNote?: string;
  redoReason?: string;
  redo?: { note?: string; reason?: string };
  disputeId?: string;
  dispute?: { id?: string; status?: string };
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

async function deliver(job: Job, code: CoinCode, preface?: string): Promise<void> {
  job.status = "delivering";
  saveJob(job);
  const text = preface ? `${preface}\n\n${deliveryText(code)}` : deliveryText(code);
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
    if (order.status === "IN_DISPUTE") return submitDisputeEvidence(orderId, order, job);
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      log.info(`order ${orderId}: status ${order.status}, nothing to do`);
      return job;
    }
    if (isRedo(order, job)) return handleRedo(job, order);
    let code = findCodeByOrder(orderId);
    if (!code) {
      job.status = "minting";
      saveJob(job);
      code = mintCode(coinsForPrice(price), { orderId, buyer: job.buyer, note: `${price} ${currency}` });
      log.info(`order ${orderId}: minted ${code.code} (${code.coins} coins for ${price} ${currency})`);
    }
    job.code = code.code;
    job.coins = code.coins;
    job.conversationId ??= await findBuyerConversation(order).catch((err) => {
      log.warn(`order ${orderId}: could not find the buyer conversation: ${String(err)}`);
      return undefined;
    });
    saveJob(job);
    if (job.status !== "delivered" && job.status !== "settled") await deliver(job, code);
    await notify("job.delivered", { orderId, code: code.code, coins: code.coins, tx: job.txHashes });
    if (job.conversationId) {
      await postNotice(job.conversationId, `✅ Delivered! ${deliveryText(code)}`).catch((err) => log.warn(`could not post delivery notice: ${String(err)}`));
    } else {
      log.warn(`order ${orderId}: no buyer conversation found, the code is only in the order delivery`);
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

// ─── redo ────────────────────────────────────────────────────────────

/**
 * A redo is the buyer's single on-chain `requestRedo`: the order drops from DELIVERED back to
 * IN_PROGRESS. We recognise it either by the platform's `redoUsed` flag or by the order being
 * back in progress after we already delivered, and answer it exactly once (job.redo).
 */
export function isRedo(order: Order, job: Job): boolean {
  if (job.redo) return false;
  if (order.redoUsed === true && (job.status === "delivered" || Boolean(job.txHashes.submitDelivery))) return true;
  // Without the flag: only a job we *saw* reach DELIVERED can be back in progress because of a redo.
  return job.status === "delivered" && order.status === "IN_PROGRESS";
}

function redoNoteOf(order: Order, job: Job): string | undefined {
  const fromOrder = order.redoNote ?? order.redoReason ?? order.redo?.note ?? order.redo?.reason;
  if (typeof fromOrder === "string" && fromOrder.trim()) return fromOrder.trim();
  if (!job.conversationId) return undefined;
  const conv = loadConversation(job.conversationId);
  const last = [...conv.messages].reverse().find((m) => m.role === "buyer");
  return last?.text;
}

/**
 * Policy: a redo is honoured only while the delivered code is untouched. If a coin was already
 * inserted the service was consumed, so we refuse — the original code (and whatever coins are
 * left on it) is re-delivered unchanged, and the buyer keeps accept/dispute. If no coin was ever
 * inserted, the old code is destroyed and a fresh code of the same value is delivered.
 */
export async function handleRedo(job: Job, order: Order): Promise<Job> {
  const old = findCodeByOrder(job.orderId);
  if (!old) throw new Error(`order ${job.orderId}: redo requested but no code on record`);
  const buyerNote = redoNoteOf(order, job);
  const used = isUsed(old);
  log.info(`order ${job.orderId}: redo requested (${used ? `refusing, ${old.used} coin(s) already inserted` : "reissuing, code unused"})${buyerNote ? ` — buyer: ${buyerNote.slice(0, 200)}` : ""}`);
  if (used) {
    job.redo = { at: new Date().toISOString(), decision: "refused", reason: `${old.used} coin(s) already inserted on ${old.code}; a used code is not replaced`, buyerNote, oldCode: old.code, coinsUsedOnOldCode: old.used };
    job.notes.push(`redo refused: ${job.redo.reason}`);
    saveJob(job);
    const preface = [
      `↩️ Redo request received — we can't replace this code.`,
      `${old.used} of its ${old.coins} coin(s) were already inserted (first play window opened ${old.sessions[0]?.startedAt ?? "earlier"}), so the service has been used. Your original code stays valid with the remaining coins and is re-delivered below. If you believe the game did not work, open a challenge on the order page and we'll attach the session logs.`,
    ].join("\n");
    await deliver(job, old, preface);
    await notify("job.redo.refused", { orderId: job.orderId, code: old.code, used: old.used, buyerNote });
    if (job.conversationId) await postNotice(job.conversationId, preface).catch((err) => log.warn(`could not post redo notice: ${String(err)}`));
    return job;
  }
  job.status = "minting";
  saveJob(job);
  const fresh = mintCode(old.coins, { orderId: job.orderId, buyer: job.buyer, note: `${old.note ?? ""} (redo of ${old.code})`.trim() });
  if (!revokeCode(old.code, `redo${buyerNote ? `: ${buyerNote.slice(0, 200)}` : ""}`, fresh.code)) throw new Error(`order ${job.orderId}: could not revoke ${old.code} for redo`);
  job.redo = { at: new Date().toISOString(), decision: "reissued", reason: "code unused at redo time", buyerNote, oldCode: old.code, newCode: fresh.code, coinsUsedOnOldCode: 0 };
  job.code = fresh.code;
  job.coins = fresh.coins;
  job.notes.push(`redo: ${old.code} revoked, ${fresh.code} issued`);
  saveJob(job);
  log.info(`order ${job.orderId}: redo — revoked ${old.code}, minted ${fresh.code}`);
  const preface = `↩️ Redo done. Your previous code ${old.code} has been cancelled (it was never used) and replaced by a fresh one below.`;
  await deliver(job, fresh, preface);
  await notify("job.redo.reissued", { orderId: job.orderId, oldCode: old.code, code: fresh.code, coins: fresh.coins, buyerNote });
  if (job.conversationId) await postNotice(job.conversationId, `${preface}\n\n${deliveryText(fresh)}`).catch((err) => log.warn(`could not post redo notice: ${String(err)}`));
  return job;
}

// ─── dispute (buyer challenge) ───────────────────────────────────────

interface Dispute {
  id?: string;
  status?: string;
  [k: string]: unknown;
}

async function getDispute(order: Order): Promise<Dispute | undefined> {
  const tx = termix();
  const byOrder = await tx.get<Dispute | { dispute?: Dispute }>(`/api/v1/orders/${order.id}/dispute`).catch(() => undefined);
  const d = byOrder && "dispute" in (byOrder as object) && (byOrder as { dispute?: Dispute }).dispute ? (byOrder as { dispute: Dispute }).dispute : (byOrder as Dispute | undefined);
  if (d?.id) return d;
  const id = order.disputeId ?? order.dispute?.id;
  if (!id) return d;
  const byId = await tx.get<Dispute | { dispute?: Dispute }>(`/api/v1/disputes/${id}`);
  return "dispute" in (byId as object) && (byId as { dispute?: Dispute }).dispute ? (byId as { dispute: Dispute }).dispute : (byId as Dispute);
}

function mask(code: string): string {
  const parts = code.split("-");
  return parts.length === 4 ? `${parts[0]}-${parts[1]}-****-${parts[3]}` : code;
}

/** Everything we know about what the buyer received and did with it, as evidence. */
export function usageEvidence(job: Job, order: Order): { text: string; json: Record<string, unknown> } {
  const codes = codesForOrder(job.orderId);
  const windows = codes.flatMap((c) => c.sessions.map((w) => ({ code: mask(c.code), ...w })));
  const played = windows.reduce((a, w) => a + (w.usage?.playSeconds ?? 0), 0);
  const inserted = codes.reduce((a, c) => a + c.used, 0);
  const json = {
    orderId: job.orderId,
    buyer: job.buyer,
    price: job.price,
    currency: job.currency,
    generatedAt: new Date().toISOString(),
    delivery: { deliveredAt: job.updatedAt, artifactIds: job.artifactIds, txHashes: job.txHashes },
    redo: job.redo,
    codes: codes.map((c) => ({ code: mask(c.code), coins: c.coins, used: c.used, createdAt: c.createdAt, revokedAt: c.revokedAt, revokedReason: c.revokedReason, replacedBy: c.replacedBy ? mask(c.replacedBy) : undefined })),
    windows,
    totals: { coinsSold: codes.filter((c) => !c.revokedAt).reduce((a, c) => a + c.coins, 0), coinsInserted: inserted, playSeconds: played, jevCalls: windows.reduce((a, w) => a + (w.usage?.jevCalls ?? 0), 0) },
    orderStatusAtEvidence: order.status,
  };
  const lines = [
    `Provider evidence for order ${job.orderId} (AI co-op buddy coin codes).`,
    `Delivered a coin code worth ${json.totals.coinsSold} coin(s) for ${job.price ?? "?"} ${job.currency ?? ""} (delivery tx ${job.txHashes.submitDelivery ?? "n/a"}, artifact ${job.artifactIds.join(", ") || "n/a"}).`,
    inserted > 0
      ? `The buyer inserted ${inserted} coin(s): ${windows.length} play window(s) opened, ${Math.round(played / 60)} minute(s) of observed play, ${json.totals.jevCalls} AI decisions served.`
      : `No coin was ever inserted on the delivered code: the service was delivered but never redeemed.`,
    ...windows.map((w) => `- window ${w.id}: game ${w.gameId}, opened ${w.startedAt}, expires ${w.expiresAt ?? "n/a"}, entries ${w.entries ?? 1}, play ${w.usage?.playSeconds ?? 0}s, ended ${w.endedAt ?? "-"} (${w.reason ?? "-"})`),
    job.redo ? `Redo request: ${job.redo.decision} at ${job.redo.at} (${job.redo.reason}).` : `No redo was requested.`,
    `Full machine-readable record attached (usage-evidence.json). Codes are masked; the delivery artifact holds the full code.`,
  ];
  return { text: lines.join("\n"), json };
}

/**
 * The buyer challenged the delivery: file our usage evidence during EVIDENCE_PHASE, once.
 * Verdict handling (accept / escalate) is left to the operator — it moves escrowed funds.
 */
export async function submitDisputeEvidence(orderId: string, order?: Order, job?: Job): Promise<Job | undefined> {
  order ??= await getOrder(orderId);
  job ??= findJobByOrder(orderId);
  if (!job) {
    log.warn(`order ${orderId}: in dispute but no job on record, cannot file evidence`);
    return undefined;
  }
  if (job.dispute?.evidenceSubmittedAt) return job;
  const dispute = await getDispute(order);
  if (!dispute?.id) {
    log.info(`order ${orderId}: IN_DISPUTE but dispute not readable yet`);
    return job;
  }
  job.status = "disputed";
  job.dispute = { ...job.dispute, disputeId: dispute.id, openedStatus: dispute.status };
  saveJob(job);
  const phase = String(dispute.status ?? "");
  if (phase && !["OPEN", "EVIDENCE_PHASE"].includes(phase)) {
    log.info(`order ${orderId}: dispute ${dispute.id} is ${phase}, evidence window closed`);
    return job;
  }
  const tx = termix();
  const { text, json } = usageEvidence(job, order);
  const dir = path.join(getConfig().dataDir, "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "usage-evidence.json");
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  const contentType = "application/json";
  const sizeBytes = fs.statSync(file).size;
  try {
    const up = await tx.api<{ uploadUrl: string; s3Key?: string; publicUrl?: string; url?: string; key?: string }>("POST", `/api/v1/disputes/${dispute.id}/evidence/upload-url`, { fileName: "usage-evidence.json", contentType, sizeBytes });
    const uploaded = await tx.upload(up.uploadUrl, file, contentType);
    const reg = await tx.api<{ id?: string; artifactId?: string; artifact?: { id: string } }>("POST", `/api/v1/disputes/${dispute.id}/evidence/artifacts`, { s3Key: up.s3Key ?? up.key, url: up.publicUrl ?? up.url, sha256: uploaded.sha256, contentType, sizeBytes });
    const artifactId = reg.id ?? reg.artifactId ?? reg.artifact?.id;
    const payload = await tx.api<{ id?: string }>("POST", `/api/v1/disputes/${dispute.id}/evidence-payloads`, artifactId ? { text, artifactId } : { text });
    job.dispute = { ...job.dispute, disputeId: dispute.id, evidenceSubmittedAt: new Date().toISOString(), artifactId, payloadId: payload?.id, error: undefined };
    job.notes.push(`dispute ${dispute.id}: evidence filed`);
    saveJob(job);
    log.info(`order ${orderId}: evidence filed on dispute ${dispute.id}`);
    await notify("job.dispute.evidence", { orderId, disputeId: dispute.id, artifactId, summary: text.split("\n").slice(0, 3).join(" ") });
  } catch (err) {
    job.dispute = { ...job.dispute, disputeId: dispute.id, error: String(err instanceof Error ? err.message : err) };
    saveJob(job);
    log.error(`order ${orderId}: evidence submission failed — ${job.dispute.error}`);
    await notify("job.dispute.failed", { orderId, disputeId: dispute.id, error: job.dispute.error });
    throw err;
  }
  return job;
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

/**
 * Orders waiting on us right now. The watcher only announces FUNDED orders, but listing checkouts
 * land in PENDING_ACCEPT (the provider accepts on-chain first), so without this poll a new order
 * waited for the next full sweep — minutes. Failed jobs are left to the sweep so a broken order
 * is not retried every few seconds.
 */
export async function pollNewOrders(): Promise<string[]> {
  // The list filter rejects status=PENDING_ACCEPT; the list is newest-first, so the head is enough.
  const res = await termix().get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider&pageSize=20`);
  const ids: string[] = [];
  for (const o of Array.isArray(res) ? res : (res.items ?? [])) {
    if (!ownsOrder(o) || !["PENDING_ACCEPT", "FUNDED"].includes(o.status)) continue;
    const job = findJobByOrder(o.id);
    if (!job || !["delivered", "settled", "failed"].includes(job.status)) ids.push(o.id);
  }
  return ids;
}

const hasOrderEvent = (c: RemoteConversation, orderId: string) =>
  [c.lastMessage, ...(c.messages ?? [])].some((m) => m?.businessType === "order" && m.businessId === orderId);

/**
 * Listing checkouts carry no conversationId on the order, but the platform opens the order in a
 * buyer↔agent thread ("Conversation opened for this order", then the chain events). That thread
 * is the buyer's inbox for this order: find it so the delivery message lands where they look.
 * A buyer can have several threads with us (one per quote), hence the match on the order event.
 */
export async function findBuyerConversation(order: Order): Promise<string | undefined> {
  const agentId = getConfig().termix.agentId;
  const buyerId = order.buyer?.id;
  if (!agentId || !buyerId) return undefined;
  const tx = termix();
  const candidates = (await tx.conversations())
    .filter((c) => {
      const parts = c.participants ?? [];
      return parts.some((p) => p.agentId === agentId) && parts.some((p) => p.role === "BUYER" && p.accountId === buyerId);
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const direct = candidates.find((c) => c.orderId === order.id || hasOrderEvent(c, order.id));
  if (direct) return direct.id;
  for (const c of candidates.slice(0, 5)) {
    const full = await tx.conversation(c.id);
    if (full && hasOrderEvent(full, order.id)) return c.id;
  }
  // No order thread (yet): the quote's thread is still a conversation the buyer has with us.
  const offerId = typeof order.offerId === "string" ? order.offerId : undefined;
  const offer = offerId ? await tx.get<{ conversationId?: string; item?: { conversationId?: string } }>(`/api/v1/offers/${offerId}`).catch(() => undefined) : undefined;
  return offer?.conversationId ?? offer?.item?.conversationId ?? candidates[0]?.id;
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
    else if ((o.status === "FUNDED" || o.status === "IN_PROGRESS") && job && isRedo(o, job)) actionable.push(o.id);
    else if (o.status === "IN_DISPUTE" && (!job?.dispute?.evidenceSubmittedAt)) actionable.push(o.id);
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
