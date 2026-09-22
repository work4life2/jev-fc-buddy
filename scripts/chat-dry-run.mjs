// Dry run of the buyer-chat agent: sends sample buyer messages through the real system prompt and
// model (relay) and prints the replies. Nothing is posted to Termix and no conversation is saved.
//   node scripts/chat-dry-run.mjs ["custom buyer message" ...]
import { chatSystemPrompt } from "../dist/jobs/chat.js";
import { createTextSession, promptForText } from "../dist/agent/session.js";

const samples = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "Hi, what exactly do I get if I buy this?",
      "How long can I play with one coin, and what if my browser crashes?",
      "Can you write me a Python script that scrapes Twitter?",
      "Do you support Super Mario Bros 3?",
      "I paid 3 USDC ten minutes ago and got nothing.",
    ];

const session = await createTextSession("chat", chatSystemPrompt(), { thinking: "off" });
for (const text of samples) {
  const prompt = `Context:\nBuyer: test-buyer.\n\nConversation so far (chronological; "You" is us):\ntest-buyer: ${text}\n\nWrite your next reply to the buyer (reply text only).`;
  const started = Date.now();
  const reply = await promptForText(session, prompt);
  process.stdout.write(`\n> ${text}\n${reply}\n(${Date.now() - started} ms)\n`);
}
process.exit(0);
