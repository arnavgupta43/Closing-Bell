// Seeds synthetic users + trades for one trade date into the PRIMARY.
// The replica receives the data through replication.
//
//   npm run seed -- --date 2026-10-16 --users 10
//
// Same arguments → same data (seeded random), so reruns are safe and results are checkable.

import { parseArgs } from "node:util";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5442/closing_bell";

// Every 5th user has no trades on the date, like real clients who didn't trade that day.
const NON_TRADER_EVERY = 5;

// Approximate prices in rupees; each trade lands within ±2% of these.
const SYMBOLS: Record<string, number> = {
  RELIANCE: 2950,
  TCS: 4100,
  INFY: 1520,
  HDFCBANK: 1680,
  ICICIBANK: 1240,
  SBIN: 820,
  ITC: 470,
  LT: 3600,
  WIPRO: 560,
  TATAMOTORS: 980,
};

type User = { id: number; email: string; name: string };
type Trade = {
  userId: number;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: string; // numeric(12,2): send as a string so no float rounding sneaks in
  exchange: "NSE" | "BSE";
  tradedAt: string;
};

function readArgs() {
  const { values } = parseArgs({
    options: {
      date: { type: "string", default: "2026-10-16" },
      users: { type: "string", default: "10" },
    },
  });

  const tradeDate = values.date;
  const userCount = Number(values.users);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || Number.isNaN(Date.parse(tradeDate))) {
    throw new Error(`--date must be YYYY-MM-DD, got "${tradeDate}"`);
  }
  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new Error(`--users must be a positive integer, got "${values.users}"`);
  }
  return { tradeDate, userCount };
}

// mulberry32: a tiny seeded random generator. Returns numbers in [0, 1), like Math.random(),
// but the sequence is fixed for a given seed.
function seededRandom(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(tradeDate: string, userCount: number) {
  // Seed from the date (2026-10-16 → 20261016): each date gets different trades,
  // but the same date always gets the same ones.
  const random = seededRandom(Number(tradeDate.replaceAll("-", "")));
  const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const symbols = Object.keys(SYMBOLS);

  const users: User[] = [];
  const trades: Trade[] = [];

  for (let id = 1; id <= userCount; id++) {
    users.push({ id, email: `user${id}@example.com`, name: `User ${id}` });
    if (id % NON_TRADER_EVERY === 0) continue;

    const tradeCount = randomInt(1, 5);
    for (let i = 0; i < tradeCount; i++) {
      const symbol = symbols[randomInt(0, symbols.length - 1)];
      const price = SYMBOLS[symbol] * (0.98 + random() * 0.04);

      // Market hours 09:15–15:30 IST = 22,500 seconds after the open.
      const secondsAfterOpen = randomInt(0, 22_500);
      const time = new Date(Date.UTC(2000, 0, 1, 9, 15, secondsAfterOpen));
      const hhmmss = time.toISOString().slice(11, 19);

      trades.push({
        userId: id,
        symbol,
        side: random() < 0.5 ? "BUY" : "SELL",
        qty: randomInt(1, 100),
        price: price.toFixed(2),
        exchange: random() < 0.8 ? "NSE" : "BSE",
        tradedAt: `${tradeDate}T${hhmmss}+05:30`,
      });
    }
  }
  return { users, trades };
}

// Multi-row INSERT in chunks. Postgres allows at most 65,535 parameters per query,
// so 1,000 rows × 8 columns per chunk stays well under it.
async function insertRows(
  client: pg.PoolClient,
  sql: string, // "INSERT INTO t (a, b) VALUES" — the placeholders are appended here
  rows: unknown[][],
  suffix = "",
) {
  for (let start = 0; start < rows.length; start += 1000) {
    const chunk = rows.slice(start, start + 1000);
    const width = chunk[0].length;
    const placeholders = chunk
      .map((row, r) => `(${row.map((_, c) => `$${r * width + c + 1}`).join(", ")})`)
      .join(", ");
    await client.query(`${sql} ${placeholders} ${suffix}`, chunk.flat());
  }
}

async function main() {
  const { tradeDate, userCount } = readArgs();
  const { users, trades } = generate(tradeDate, userCount);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    // One transaction: a crash halfway leaves the database exactly as it was.
    await client.query("BEGIN");

    // Rerunning a date replaces its trades instead of duplicating them. Other dates are untouched.
    await client.query("DELETE FROM trades WHERE trade_date = $1", [tradeDate]);

    await insertRows(
      client,
      "INSERT INTO users (id, email, name) VALUES",
      users.map((u) => [u.id, u.email, u.name]),
      "ON CONFLICT (id) DO NOTHING",
    );

    if (trades.length > 0) {
      await insertRows(
        client,
        "INSERT INTO trades (user_id, trade_date, symbol, side, qty, price, exchange, traded_at) VALUES",
        trades.map((t) => [t.userId, tradeDate, t.symbol, t.side, t.qty, t.price, t.exchange, t.tradedAt]),
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Summary read back from the database, not from memory, so it shows what was really written.
  // The <...> tells TypeScript the row shape; it can't read the SQL to work it out itself.
  type Summary = { trades: number; traders: number; nse: number; bse: number; buys: number; sells: number };
  const { rows } = await pool.query<Summary>(
    `SELECT count(*)::int                         AS trades,
            count(DISTINCT user_id)::int          AS traders,
            count(*) FILTER (WHERE exchange = 'NSE')::int AS nse,
            count(*) FILTER (WHERE exchange = 'BSE')::int AS bse,
            count(*) FILTER (WHERE side = 'BUY')::int     AS buys,
            count(*) FILTER (WHERE side = 'SELL')::int    AS sells
     FROM trades WHERE trade_date = $1`,
    [tradeDate],
  );
  await pool.end();

  const s = rows[0];
  console.log(`Seeded ${tradeDate}: ${userCount} users, ${s.traders} traded, ${s.trades} trades`);
  console.log(`  NSE ${s.nse} / BSE ${s.bse}   BUY ${s.buys} / SELL ${s.sells}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
