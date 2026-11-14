import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BatchUser } from "../../shared/types.ts";
import { calculateNote, renderNote } from "../src/render-note.ts";

const TRADE_DATE = "2026-10-16";

// A fresh copy per test, so one test changing it can't affect another.
const sampleUser = (): BatchUser =>
  JSON.parse(readFileSync(new URL("./sample-user.json", import.meta.url), "utf8"));

test("calculates values, totals and net amount", () => {
  const note = calculateNote(sampleUser(), TRADE_DATE);

  assert.equal(note.noteNo, "CN-20261016-U1042");
  assert.deepEqual(note.lines.map((l) => l.value), [15205, 19450]); // 10 × 1520.5, 5 × 3890
  assert.equal(note.buyValue, 15205);
  assert.equal(note.sellValue, 19450);
  assert.equal(note.totalCharges, 45.92); // no 45.919999… float error
  assert.equal(note.net, 4199.08); // 19450 − 15205 − 45.92: client receives
});

test("net is negative when the client only buys", () => {
  const user = sampleUser();
  user.trades = user.trades.filter((t) => t.side === "BUY");

  assert.equal(calculateNote(user, TRADE_DATE).net, -15250.92); // −15205 − 45.92
});

test("produces a real PDF", async () => {
  const { pdf } = await renderNote(sampleUser(), TRADE_DATE);

  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
});

test("same input gives identical bytes and hash", async () => {
  const a = await renderNote(sampleUser(), TRADE_DATE);
  const b = await renderNote(sampleUser(), TRADE_DATE);

  assert.equal(a.hash, b.hash);
  assert.ok(a.pdf.equals(b.pdf));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test("changing one trade changes the hash", async () => {
  const original = await renderNote(sampleUser(), TRADE_DATE);

  const tampered = sampleUser();
  tampered.trades[0].price = 1520.6;
  const changed = await renderNote(tampered, TRADE_DATE);

  assert.notEqual(original.hash, changed.hash);
});

test("handles a single trade with zero charges", async () => {
  const user = sampleUser();
  user.trades = [user.trades[0]];
  user.charges = { brokerage: 0, stt: 0, exchangeTxn: 0, gst: 0, sebi: 0, stampDuty: 0 };

  const note = calculateNote(user, TRADE_DATE);
  assert.equal(note.totalCharges, 0);
  assert.equal(note.net, -15205);

  const { pdf } = await renderNote(user, TRADE_DATE);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
