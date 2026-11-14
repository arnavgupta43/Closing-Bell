// Layer 2a end-to-end: upload the sample batch to LocalStack S3, run the PDF worker's
// handler on it (from the laptop, not yet as a deployed Lambda), and print the result.
// Stands in for Extract (layer 3) and Step Functions (layer 4).
//
//   docker compose up -d
//   npm run run-batch
//
// No idempotency yet (layer 5): running it twice sends the emails twice.

import { readFileSync } from "node:fs";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, REGION, makeS3Client } from "../packages/shared/s3.ts";
import { handler } from "../packages/pdf-worker/src/handler.ts";
import type { Batch } from "../packages/shared/types.ts";

const s3 = makeS3Client();
const batch: Batch = JSON.parse(readFileSync("packages/pdf-worker/test/sample-batch.json", "utf8"));
const key = `batches/${batch.tradeDate}/batch-0001.json`;

// LocalStack forgets everything on restart, so make sure the bucket exists.
try {
  await s3.send(
    new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }),
  );
} catch (err) {
  if ((err as Error).name !== "BucketAlreadyOwnedByYou") throw err;
}

await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(batch) }));
console.log(`uploaded s3://${BUCKET}/${key} (${batch.users.length} users)`);

const started = Date.now();
const result = await handler({ key });
console.log(`handler finished in ${Date.now() - started} ms`);
console.log(JSON.stringify(result, null, 2));
console.log("Inbox: http://localhost:8025");
