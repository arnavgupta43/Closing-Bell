// Layer 3: Extract from the laptop. Reads the READ REPLICA, writes batch files to LocalStack S3.
// In layer 4 the same extractRange runs as one ECS Fargate task per range, started by Step Functions.
//
//   npm run extract -- --date 2026-10-16 --ranges 2 --batch-size 1000
//
// Rerun-safe: file names are deterministic, so a rerun overwrites the same files with the same content.

import { parseArgs } from "node:util";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { BUCKET, ensureBucket, makeS3Client } from "../packages/shared/s3.ts";
import { extractRange, fetchPage, splitRanges, userBounds } from "../packages/extract/src/extract-range.ts";

// Port 5443 = the replica. Extract never reads the primary: the heavy read must not slow down writes.
const REPLICA_URL =
  process.env.REPLICA_URL ?? "postgres://postgres:postgres@localhost:5443/closing_bell";

const { values } = parseArgs({
  options: {
    date: { type: "string", default: "2026-10-16" },
    ranges: { type: "string", default: "2" },
    "batch-size": { type: "string", default: "1000" },
  },
});
const tradeDate = values.date;
const rangeCount = Number(values.ranges);
const batchSize = Number(values["batch-size"]);
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`--date must be YYYY-MM-DD, got "${tradeDate}"`);
if (!(rangeCount >= 1 && batchSize >= 1)) throw new Error("--ranges and --batch-size must be positive integers");

const s3 = makeS3Client();
await ensureBucket(s3);

// One connection per range, so the ranges really read in parallel.
const db = new pg.Pool({ connectionString: REPLICA_URL, max: rangeCount });

const bounds = await userBounds(db, tradeDate);
if (!bounds) {
  console.log(`no trades on ${tradeDate}; nothing to extract`);
  await db.end();
  process.exit(0);
}

const ranges = splitRanges(bounds.min, bounds.max, rangeCount);
const deps = {
  fetchPage: (date: string, after: number, to: number, limit: number) => fetchPage(db, date, after, to, limit),
  putBatch: async (key: string, batch: object) => {
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(batch), ContentType: "application/json" }),
    );
  },
};

// All ranges at once. If any range throws, Promise.all rejects and the script fails loudly;
// Step Functions would retry that range's task (its files are simply overwritten).
const started = Date.now();
const results = await Promise.all(ranges.map((range) => extractRange(tradeDate, range, batchSize, deps)));
await db.end();

for (const r of results) {
  console.log(
    `range ${r.range.rangeNo} (users ${r.range.fromUser}-${r.range.toUser}): ${r.users} users → ${r.files.length} files`,
  );
}
const users = results.reduce((n, r) => n + r.users, 0);
const files = results.reduce((n, r) => n + r.files.length, 0);
console.log(`extracted ${users} users into ${files} files in ${Date.now() - started} ms`);
