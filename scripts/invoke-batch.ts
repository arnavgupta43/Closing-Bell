// Layer 2b end-to-end: upload the sample batch to LocalStack S3 and invoke the deployed
// pdf-worker Lambda with its key. Plays the part of Extract (layer 3) + Step Functions (layer 4).
//
//   docker compose up -d
//   npm run deploy-lambda
//   npm run invoke-batch
//
// No idempotency yet (layer 5): invoking twice sends the emails twice.

import { readFileSync } from "node:fs";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, ensureBucket, makeS3Client } from "../packages/shared/s3.ts";
import type { Batch } from "../packages/shared/types.ts";
import { FUNCTION_NAME, makeLambdaClient } from "./lambda-client.ts";

const s3 = makeS3Client();
const batch: Batch = JSON.parse(readFileSync("packages/pdf-worker/test/sample-batch.json", "utf8"));
const key = `batches/${batch.tradeDate}/batch-0001.json`;

await ensureBucket(s3);
await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(batch) }));
console.log(`uploaded s3://${BUCKET}/${key} (${batch.users.length} users)`);

// RequestResponse = wait for the result (Step Functions does the same). LogType Tail returns
// the last 4 KB of the function's logs with the response, so we don't need CloudWatch.
const started = Date.now();
const res = await makeLambdaClient().send(
  new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    InvocationType: "RequestResponse",
    LogType: "Tail",
    Payload: JSON.stringify({ key }),
  }),
);
console.log(`lambda finished in ${Date.now() - started} ms`);

if (res.LogResult) {
  console.log("--- lambda log tail ---");
  console.log(Buffer.from(res.LogResult, "base64").toString("utf8").trim());
  console.log("-----------------------");
}

const payload = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
// A thrown error still returns HTTP 200 from Invoke; FunctionError is how you tell it failed.
if (res.FunctionError) {
  console.error(`lambda failed (${res.FunctionError}): ${payload}`);
  process.exit(1);
}
console.log(JSON.stringify(JSON.parse(payload), null, 2));
console.log("Inbox: http://localhost:8025");
