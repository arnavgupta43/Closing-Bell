// One place that knows how to reach S3, so the rest of the code doesn't care where it runs.

import { S3Client } from "@aws-sdk/client-s3";

export const REGION = "ap-south-1";
export const BUCKET = process.env.BUCKET ?? "contract-notes";

// Locally: LocalStack with dummy credentials and path-style URLs.
// LocalStack sets AWS_ENDPOINT_URL inside the Lambda containers it runs (layer 2b).
// Real AWS (layer 8): no endpoint override, real credentials from the Lambda's IAM role.
export function makeS3Client(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}
