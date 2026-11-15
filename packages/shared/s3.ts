// One place that knows how to reach S3, so the rest of the code doesn't care where it runs.

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

export const REGION = "ap-south-1";
export const BUCKET = process.env.BUCKET ?? "contract-notes";

// Where is "S3"?
//   laptop script          -> LocalStack at localhost:4566
//   Lambda in LocalStack   -> LocalStack sets AWS_ENDPOINT_URL inside the container
//   Lambda on real AWS     -> no override: the SDK's default endpoint (layer 8)
// AWS_LAMBDA_FUNCTION_NAME is set by every Lambda runtime, LocalStack's and AWS's alike.
export function localEndpoint(): string | undefined {
  if (process.env.AWS_ENDPOINT_URL) return process.env.AWS_ENDPOINT_URL;
  return process.env.AWS_LAMBDA_FUNCTION_NAME ? undefined : "http://localhost:4566";
}

export function makeS3Client(): S3Client {
  const endpoint = localEndpoint();
  if (!endpoint) return new S3Client({ region: REGION }); // real AWS: credentials from the IAM role
  return new S3Client({
    region: REGION,
    endpoint,
    forcePathStyle: true, // localhost:4566/bucket/key instead of bucket.localhost:4566/key
    credentials: { accessKeyId: "test", secretAccessKey: "test" }, // LocalStack accepts anything
  });
}

// LocalStack forgets everything on restart, so scripts call this before using the bucket.
export async function ensureBucket(s3: S3Client): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }),
    );
  } catch (err) {
    if ((err as Error).name !== "BucketAlreadyOwnedByYou") throw err;
  }
}
