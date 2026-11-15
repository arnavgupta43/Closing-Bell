// BuildManifest Lambda entry point: wires the real S3 into buildManifest.
// Input { tradeDate } comes from the Step Functions execution input (layer 4).
// For now scripts/build-manifest.ts calls this directly from the laptop.

import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, makeS3Client } from "../../shared/s3.ts";
import { buildManifest } from "./build-manifest.ts";

const s3 = makeS3Client();

// ListObjectsV2 returns at most 1,000 keys per call. 2M users / 1,000 per file = 2,000 files,
// so keep asking with the continuation token until S3 says there is no more.
async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

export async function handler(event: { tradeDate: string }) {
  const result = await buildManifest(event.tradeDate, {
    listKeys,
    putManifest: async (key, manifest) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: JSON.stringify(manifest, null, 2),
          ContentType: "application/json",
        }),
      );
    },
  });
  return { bucket: BUCKET, ...result };
}
