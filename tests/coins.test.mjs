import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jev-coins-"));
const { mintCode, findCode, findCodeByOrder, codesForOrder, revokeCode, spendCoin, isUsed, remaining } = await import("../dist/coins/store.js");
const { isRedo } = await import("../dist/jobs/orderWorker.js");

test("an unused code can be revoked and is then unusable; the order resolves to the replacement", () => {
  const old = mintCode(2, { orderId: "o1" });
  assert.equal(isUsed(old), false);
  const fresh = mintCode(2, { orderId: "o1" });
  assert.equal(revokeCode(old.code, "redo", fresh.code), true);
  assert.equal(findCode(old.code)?.revokedAt !== undefined, true);
  assert.equal(remaining(findCode(old.code)), 0);
  assert.equal(spendCoin(old.code, "contra"), undefined);
  assert.equal(findCodeByOrder("o1")?.code, fresh.code);
  assert.equal(codesForOrder("o1").length, 2);
  assert.equal(revokeCode(old.code, "again"), false);
});

test("a code with an inserted coin refuses revocation", () => {
  const c = mintCode(1, { orderId: "o2" });
  assert.ok(spendCoin(c.code, "contra"));
  assert.equal(isUsed(findCode(c.code)), true);
  assert.equal(revokeCode(c.code, "redo"), false);
  assert.equal(findCode(c.code).revokedAt, undefined);
});

test("redo is recognised only for a job that reached DELIVERED and is answered once", () => {
  const job = { status: "delivered", txHashes: { submitDelivery: "0x1" } };
  assert.equal(isRedo({ id: "o", status: "IN_PROGRESS" }, job), true);
  assert.equal(isRedo({ id: "o", status: "IN_PROGRESS", redoUsed: true }, { status: "delivering", txHashes: { submitDelivery: "0x1" } }), true);
  assert.equal(isRedo({ id: "o", status: "IN_PROGRESS" }, { status: "delivering", txHashes: { submitDelivery: "0x1" } }), false);
  assert.equal(isRedo({ id: "o", status: "IN_PROGRESS" }, { ...job, redo: { decision: "refused" } }), false);
  assert.equal(isRedo({ id: "o", status: "DELIVERED" }, job), false);
});
