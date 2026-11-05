import assert from "node:assert/strict";
import test from "node:test";
import { BOT_REPLY_BUDGET, NO_REPLY, replyOrSilence, skipReason } from "../dist/jobs/agentChat.js";

// Two auto-replying agents once answered each other without end. These pin when
// the buyer chat stays quiet.
const at = (ms) => new Date(ms).toISOString();
const now = Date.parse("2026-11-05T08:00:00Z");

test("never answers where we started the conversation", () => {
  assert.match(skipReason({ myRole: "CLIENT", fromAutomated: false }, [{ role: "buyer", text: "hi", at: at(now) }], now), /client side/);
});

test("a person is never skipped, however chatty", () => {
  const log = [];
  for (let i = 0; i < 20; i++) log.push({ role: "buyer", text: "hi", at: at(now) }, { role: "agent", text: "hello", at: at(now) });
  log.push({ role: "buyer", text: "hi", at: at(now) });
  assert.equal(skipReason({ myRole: "PROVIDER", fromAutomated: false }, log, now), null);
  assert.equal(skipReason({}, log, now), null, "older backend: no fields, no skip");
});

test("a bot repeating its previous message gets no reply", () => {
  const log = [{ role: "buyer", text: "Hello! How can I help?", at: at(now) }, { role: "agent", text: "Hi", at: at(now) }, { role: "buyer", text: "hello!  how can i help?", at: at(now) }];
  assert.match(skipReason({ fromAutomated: true }, log, now), /repeat/);
});

test("a bot gets at most the budget of replies per window", () => {
  const log = [];
  for (let i = 0; i < BOT_REPLY_BUDGET; i++) log.push({ role: "buyer", text: `q${i}`, at: at(now - 60_000) }, { role: "agent", text: `a${i}`, at: at(now - 60_000) });
  log.push({ role: "buyer", text: "next", at: at(now) });
  assert.match(skipReason({ fromAutomated: true }, log, now), /budget/);
  assert.equal(skipReason({ fromAutomated: true }, log, now + 11 * 60_000), null, "window frees up");
});

test("NO_REPLY silences only a bot", () => {
  assert.equal(replyOrSilence(NO_REPLY, { fromAutomated: true }), null);
  assert.equal(replyOrSilence(`${NO_REPLY} Sure!`, { fromAutomated: false }), "Sure!");
  assert.equal(replyOrSilence("Sure, 3 days.", { fromAutomated: true }), "Sure, 3 days.");
});
