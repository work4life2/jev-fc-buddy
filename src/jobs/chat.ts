import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { createTextSession, promptForText } from "../agent/session.js";
import { termix, type WatchEvent } from "../termix/client.js";
import { playableGames } from "../games/registry.js";
import { findJobByOrder, loadConversation, saveConversation } from "./store.js";

const log = logger("chat");

function senderName(from: WatchEvent["from"]): string {
  if (!from) return "buyer";
  if (typeof from === "string") return from;
  return from.displayName ?? from.handle ?? from.walletAddress ?? "buyer";
}

/** System prompt for buyer chat (sales + support). Product facts come from the config, never invented. */
export function chatSystemPrompt(): string {
  const cfg = getConfig();
  const games = playableGames()
    .map((g) => `${g.title}${g.titleLocal ? ` (${g.titleLocal})` : ""}`)
    .join(", ");
  return `You are the sales and support agent for "${cfg.service.title}" on the Termix agent marketplace.

What is sold: coin codes for an AI co-op buddy that plays classic NES games together with the buyer in the browser. Price: ${cfg.service.price} ${cfg.service.currency} per coin (1 coin = one play session of up to ${cfg.coins.sessionMinutes} minutes; buying for N ${cfg.service.currency} gives N coins on one code). After the order is funded the code and the play link are delivered automatically within minutes — no human in the loop.
Games available now: ${games || "none yet"}. More games are added over time; do not promise specific titles that are not in this list.
How it plays: desktop browser, the buyer is player 1 (keyboard or any gamepad), the AI is player 2 and follows/covers the buyer. The AI's inputs and live commentary scroll on the right of the game screen. The buddy is driven by TypeSafe's Jev model for split-second decisions plus an LLM coach.
Play page: ${cfg.http.publicBaseUrl}/

Rules: answer in the buyer's language; be brief and friendly; never ask for private keys or payment outside the marketplace; if asked for a refund or something you cannot do, explain that the order page has the dispute/redo actions. If the buyer already has an order, tell them their code arrives in the delivery of that order. Reply text only, no markdown headings.`;
}

export async function handleChatMessage(ev: WatchEvent): Promise<void> {
  const conversationId = ev.conversationId;
  const text = (ev.text ?? "").trim();
  if (!conversationId || !text) return;
  const conv = loadConversation(conversationId);
  if (ev.messageId && conv.messages.some((m) => m.messageId === ev.messageId)) return;
  if (ev.orderId) conv.orderId = String(ev.orderId);
  conv.buyer = senderName(ev.from);
  conv.messages.push({ role: "buyer", text, at: new Date().toISOString(), messageId: ev.messageId });
  saveConversation(conv);

  const tx = termix();
  await tx.signal(conversationId);
  const keepAlive = setInterval(() => void tx.signal(conversationId), 30_000);
  try {
    const context: string[] = [`Buyer: ${conv.buyer}.`];
    if (conv.orderId) {
      const job = findJobByOrder(conv.orderId);
      context.push(job ? `Order ${conv.orderId}: job status ${job.status}${job.code ? `, code delivered: ${job.code}` : ""}${job.error ? `, last error: ${job.error}` : ""}.` : `Order ${conv.orderId}: no delivery yet (starts automatically once funded).`);
    }
    const history = conv.messages
      .slice(-16)
      .map((m) => `${m.role === "buyer" ? conv.buyer : "You"}: ${m.text}`)
      .join("\n");
    const prompt = `Context:\n${context.join("\n")}\n\nConversation so far (chronological; "You" is us):\n${history}\n\nWrite your next reply to the buyer (reply text only).`;
    const session = await createTextSession("chat", chatSystemPrompt(), { thinking: "off" });
    let reply: string;
    try {
      reply = await promptForText(session, prompt);
    } finally {
      session.dispose();
    }
    if (!reply) reply = "Got it — one moment please.";
    await tx.reply(conversationId, reply, ev.messageId ? `auto-${ev.messageId}` : undefined);
    conv.messages.push({ role: "agent", text: reply, at: new Date().toISOString() });
    saveConversation(conv);
    log.info(`replied in ${conversationId}`, { chars: reply.length });
  } finally {
    clearInterval(keepAlive);
  }
}

/** Post a plain notice (delivery, failure) into a conversation, without the model. */
export async function postNotice(conversationId: string, text: string): Promise<void> {
  const conv = loadConversation(conversationId);
  await termix().reply(conversationId, text);
  conv.messages.push({ role: "agent", text, at: new Date().toISOString() });
  saveConversation(conv);
}
