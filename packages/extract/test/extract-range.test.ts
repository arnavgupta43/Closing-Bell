// The keyset loop against an in-memory "replica": no Docker. The fake fetchPage follows the same
// rules as the SQL (next `limit` users after `afterUser`, up to `toUser`, with all their trades).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Batch } from "../../shared/types.ts";
import {
  batchKey, extractRange, splitRanges, toBatchUsers, type ExtractDeps, type TradeRow,
} from "../src/extract-range.ts";

const DATE = "2026-10-16";

// Users 1..10; user N has N % 3 + 1 trades; every 5th user didn't trade (like the seed script).
function fakeRows(): TradeRow[] {
  const rows: TradeRow[] = [];
  let tradeId = 1;
  for (let u = 1; u <= 10; u++) {
    if (u % 5 === 0) continue;
    for (let i = 0; i < (u % 3) + 1; i++) {
      rows.push({
        trade_id: String(tradeId++), user_id: String(u), email: `user${u}@example.com`, name: `User ${u}`,
        symbol: "INFY", side: "BUY", qty: 1, price: "1520.50", exchange: "NSE", time: "10:00:00",
      });
    }
  }
  return rows;
}

function fakeDeps(rows: TradeRow[]) {
  const written = new Map<string, Batch>();
  const pageCalls: number[] = [];
  const deps: ExtractDeps = {
    fetchPage: async (_date, afterUser, toUser, limit) => {
      pageCalls.push(afterUser);
      const ids = [...new Set(rows.map((r) => Number(r.user_id)))]
        .filter((id) => id > afterUser && id <= toUser)
        .slice(0, limit);
      return rows.filter((r) => ids.includes(Number(r.user_id)));
    },
    putBatch: async (key, batch) => void written.set(key, batch),
  };
  return { deps, written, pageCalls };
}

test("splitRanges covers every ID exactly once", () => {
  assert.deepEqual(splitRanges(1, 9, 2), [
    { rangeNo: 1, fromUser: 1, toUser: 5 },
    { rangeNo: 2, fromUser: 6, toUser: 9 },
  ]);
  // More ranges than users: no empty ranges.
  assert.deepEqual(splitRanges(4, 5, 8).length, 2);
});

test("batchKey is deterministic and range-scoped", () => {
  assert.equal(batchKey(DATE, 2, 7), "batches/2026-10-16/batch-02-0007.json");
});

test("toBatchUsers groups rows by user and computes charges", () => {
  const users = toBatchUsers(fakeRows().filter((r) => r.user_id === "2"));
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "U2");
  assert.equal(users[0].trades.length, 3);
  assert.equal(users[0].trades[0].price, 1520.5); // string from pg → number
  assert.ok(users[0].charges.stt > 0);
});

test("pages through a range by keyset, never splitting a user across files", async () => {
  const { deps, written, pageCalls } = fakeDeps(fakeRows());

  const result = await extractRange(DATE, { rangeNo: 1, fromUser: 1, toUser: 10 }, 3, deps);

  // 8 traders (5 and 10 didn't trade), 3 per file → 3, 3, 2.
  assert.equal(result.users, 8);
  assert.deepEqual(result.files, [
    "batches/2026-10-16/batch-01-0001.json",
    "batches/2026-10-16/batch-01-0002.json",
    "batches/2026-10-16/batch-01-0003.json",
  ]);
  assert.deepEqual(written.get(result.files[0])!.users.map((u) => u.id), ["U1", "U2", "U3"]);
  assert.deepEqual(written.get(result.files[1])!.users.map((u) => u.id), ["U4", "U6", "U7"]);

  // Each page starts after the last user of the previous one; the 4th call finds nothing and stops.
  assert.deepEqual(pageCalls, [0, 3, 7, 9]);

  // Every trade landed in exactly one file.
  const trades = [...written.values()].flatMap((b) => b.users.flatMap((u) => u.trades));
  assert.equal(trades.length, fakeRows().length);
});

test("stays inside its range", async () => {
  const { deps, written } = fakeDeps(fakeRows());

  await extractRange(DATE, { rangeNo: 2, fromUser: 6, toUser: 10 }, 1000, deps);

  const ids = [...written.values()].flatMap((b) => b.users.map((u) => u.id));
  assert.deepEqual(ids, ["U6", "U7", "U8", "U9"]);
});

test("rerun writes the same keys with the same content", async () => {
  const first = fakeDeps(fakeRows());
  const second = fakeDeps(fakeRows());
  const range = { rangeNo: 1, fromUser: 1, toUser: 10 };

  await extractRange(DATE, range, 3, first.deps);
  await extractRange(DATE, range, 3, second.deps);

  assert.deepEqual([...second.written.entries()], [...first.written.entries()]);
});
