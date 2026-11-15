// Layer 3 end to end: read the manifest and invoke the deployed pdf-worker Lambda once per file.
// This plays the Distributed Map's part until layer 4, one file at a time (the Map runs N at once).
//
//   npm run deploy-lambda      (once per LocalStack start)
//   npm run send-manifest -- --date 2026-10-16
//
// No idempotency yet (layer 5): running it twice sends the emails twice.

import { parseArgs } from "node:util";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, makeS3Client } from "../packages/shared/s3.ts";
import { manifestKey } from "../packages/manifest/src/build-manifest.ts";
import type { BatchResult, Manifest } from "../packages/shared/types.ts";
import { FUNCTION_NAME, makeLambdaClient } from "./lambda-client.ts";

const { values } = parseArgs({ options: { date: { type: "string", default: "2026-10-16" } } });

const res = await makeS3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: manifestKey(values.date) }));
const manifest: Manifest = JSON.parse(await res.Body!.transformToString());
console.log(`manifest ${manifestKey(values.date)}: ${manifest.files.length} files`);

const lambda = makeLambdaClient();
let sent = 0;
const failed: BatchResult["failed"] = [];

for (const key of manifest.files) {
  const out = await lambda.send(
    new InvokeCommand({ FunctionName: FUNCTION_NAME, Payload: JSON.stringify({ key }) }),
  );
  const payload = Buffer.from(out.Payload ?? []).toString("utf8");
  if (out.FunctionError) throw new Error(`${key} failed (${out.FunctionError}): ${payload}`);

  const result: BatchResult = JSON.parse(payload);
  sent += result.sent;
  failed.push(...result.failed);
  console.log(`${key}: sent ${result.sent}, failed ${result.failed.length}`);
}

console.log(`total: sent ${sent}, failed ${failed.length}`);
for (const f of failed) console.log(`  ${f.userId}: ${f.reason}`);
console.log("Inbox: http://localhost:8025");
