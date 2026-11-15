// Extract: read one user-ID range for one trade date from the READ REPLICA and write it to S3 as
// batch files of `batchSize` users each. Several ranges run in parallel, each on its own connection.
//
//   replica ──page of 1,000 users──► group rows by user + compute charges ──► batches/<date>/batch-RR-PPPP.json
//              (keyset: user_id > last one we saw)

import type pg from "pg";
import type { Batch, BatchUser, Trade } from "../../shared/types.ts";
import { computeCharges } from "./charges.ts";

// A slice of the user-ID space, both ends inclusive. rangeNo goes into the file names.
export type Range = { rangeNo: number; fromUser: number; toUser: number };

// One row of the page query: a trade with its user's details repeated on it.
// pg returns bigint and numeric columns as strings (they can exceed JS number precision).
export type TradeRow = {
  trade_id: string;
  user_id: string;
  email: string;
  name: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: string;
  exchange: "NSE" | "BSE";
  time: string; // HH:MM:SS in IST
};

// What extractRange needs from the outside world. The script passes the real replica and S3;
// tests pass fakes, so the paging logic is tested without Docker.
export type ExtractDeps = {
  fetchPage: (tradeDate: string, afterUser: number, toUser: number, limit: number) => Promise<TradeRow[]>;
  putBatch: (key: string, batch: Batch) => Promise<void>;
};

// Lowest and highest user who traded on the date, or null if nobody did (e.g. a holiday).
export async function userBounds(db: pg.Pool, tradeDate: string) {
  const { rows } = await db.query<{ min: string | null; max: string | null }>(
    "SELECT min(user_id) AS min, max(user_id) AS max FROM trades WHERE trade_date = $1",
    [tradeDate],
  );
  const { min, max } = rows[0];
  return min === null || max === null ? null : { min: Number(min), max: Number(max) };
}

// Split [min, max] into `count` ranges of (nearly) equal ID width.
// Equal width ≠ equal work if IDs are unevenly spread; good enough when IDs are dense.
export function splitRanges(min: number, max: number, count: number): Range[] {
  const width = Math.ceil((max - min + 1) / count);
  const ranges: Range[] = [];
  for (let from = min, rangeNo = 1; from <= max; from += width, rangeNo++) {
    ranges.push({ rangeNo, fromUser: from, toUser: Math.min(from + width - 1, max) });
  }
  return ranges;
}

// Deterministic name: the same range and page always get the same key. A crashed extractor
// that reruns overwrites its own files instead of adding new ones, and two ranges never collide.
export function batchKey(tradeDate: string, rangeNo: number, pageNo: number): string {
  const rr = String(rangeNo).padStart(2, "0");
  const pppp = String(pageNo).padStart(4, "0");
  return `batches/${tradeDate}/batch-${rr}-${pppp}.json`;
}

// One page = the next `limit` users who traded, after `afterUser`, up to `toUser`, with ALL their
// trades. Paging by users (not trades) means one user's trades are never split across two files.
//
// Keyset, not OFFSET: "user_id > $2" jumps straight there on the (trade_date, user_id) index.
// OFFSET 5000 would make Postgres read and throw away 5,000 rows first, every page slower than the last.
export async function fetchPage(db: pg.Pool, tradeDate: string, afterUser: number, toUser: number, limit: number) {
  const { rows } = await db.query<TradeRow>(
    `WITH page AS (
       SELECT DISTINCT user_id FROM trades
       WHERE trade_date = $1 AND user_id > $2 AND user_id <= $3
       ORDER BY user_id
       LIMIT $4
     )
     SELECT t.id AS trade_id, t.user_id, u.email, u.name,
            t.symbol, t.side, t.qty, t.price, t.exchange,
            to_char(t.traded_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS time
     FROM page
     JOIN trades t ON t.user_id = page.user_id AND t.trade_date = $1
     JOIN users  u ON u.id = page.user_id
     ORDER BY t.user_id, t.traded_at, t.id`,
    [tradeDate, afterUser, toUser, limit],
  );
  return rows;
}

// Rows arrive sorted by user, so a user's trades are next to each other: start a new user
// whenever user_id changes.
export function toBatchUsers(rows: TradeRow[]): BatchUser[] {
  const users: Omit<BatchUser, "charges">[] = [];
  let current: Omit<BatchUser, "charges"> | undefined;

  for (const row of rows) {
    const id = `U${row.user_id}`;
    if (current?.id !== id) {
      current = { id, email: row.email, name: row.name, trades: [] };
      users.push(current);
    }
    const trade: Trade = {
      tradeId: `T${row.trade_id}`,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: Number(row.price),
      exchange: row.exchange,
      time: row.time,
    };
    current.trades.push(trade);
  }

  // Charges once per user, after all their trades are collected.
  return users.map((user) => ({ ...user, charges: computeCharges(user.trades) }));
}

// The keyset loop for one range: fetch a page, write it, remember the last user, repeat until empty.
export async function extractRange(tradeDate: string, range: Range, batchSize: number, deps: ExtractDeps) {
  const files: string[] = [];
  let users = 0;
  let afterUser = range.fromUser - 1; // "greater than" this, so the first user in the range is included

  for (let pageNo = 1; ; pageNo++) {
    const rows = await deps.fetchPage(tradeDate, afterUser, range.toUser, batchSize);
    if (rows.length === 0) break; // range finished

    const batchUsers = toBatchUsers(rows);
    const key = batchKey(tradeDate, range.rangeNo, pageNo);
    await deps.putBatch(key, { tradeDate, users: batchUsers });

    files.push(key);
    users += batchUsers.length;
    afterUser = Number(rows[rows.length - 1].user_id); // the keyset: where the next page starts
  }

  return { range, files, users };
}
