// Smoke test for LocalStack + Mailpit: AWS calls reach LocalStack, and email reaches Mailpit.
//
//   npm run stack-smoke

import { randomUUID } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";

const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = "ap-south-1"; // Mumbai, where an Indian broker would run this
const BUCKET = "contract-notes";
const MAILPIT_API = "http://localhost:8025/api/v1";

// The only difference from real AWS is the endpoint (and dummy credentials, which LocalStack ignores).
const s3 = new S3Client({
  endpoint: AWS_ENDPOINT,
  region: REGION,
  forcePathStyle: true, // http://localhost:4566/contract-notes/key instead of contract-notes.localhost:4566/key
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// A unique id per run, so we never mistake an old file or email for this run's.
const runId = randomUUID().slice(0, 8);

async function checkLocalStack() {
  const res = await fetch(`${AWS_ENDPOINT}/_localstack/health`);
  if (!res.ok) throw new Error(`LocalStack health returned HTTP ${res.status}`);

  const health = (await res.json()) as { edition?: string; services: Record<string, string> };
  const s3Status = health.services.s3;
  if (s3Status !== "available" && s3Status !== "running") {
    throw new Error(`LocalStack S3 is "${s3Status}"`);
  }
  console.log(`✓ LocalStack is up (edition: ${health.edition ?? "unknown"}, s3: ${s3Status})`);
}

async function checkS3() {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: BUCKET,
        // Outside us-east-1, S3 needs the region spelled out when creating a bucket.
        CreateBucketConfiguration: { LocationConstraint: REGION },
      }),
    );
  } catch (err) {
    // Rerunning the smoke test is fine: the bucket from last time is ours.
    if ((err as Error).name !== "BucketAlreadyOwnedByYou") throw err;
  }

  const key = `smoke/${runId}.txt`;
  const body = `hello from run ${runId}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));

  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await got.Body?.transformToString();
  if (text !== body) throw new Error(`S3 read back "${text}", expected "${body}"`);
  console.log(`✓ S3: wrote and read s3://${BUCKET}/${key}`);
}

async function checkEmail() {
  const transport = nodemailer.createTransport({ host: "localhost", port: 1025, secure: false });
  const subject = `Smoke test ${runId}`;
  await transport.sendMail({
    from: "notes@closingbell.local",
    to: "user1@example.com",
    subject,
    text: "If you can read this in Mailpit, SMTP works.",
    attachments: [{ filename: "note.txt", content: "pretend this is a PDF" }],
  });

  // Ask Mailpit's API whether the email arrived (the same inbox you see at localhost:8025).
  const res = await fetch(`${MAILPIT_API}/messages`);
  const inbox = (await res.json()) as { messages: { Subject: string; Attachments: number }[] };
  const found = inbox.messages.find((m) => m.Subject === subject);
  if (!found) throw new Error(`Email "${subject}" not found in Mailpit`);
  if (found.Attachments !== 1) throw new Error(`Expected 1 attachment, got ${found.Attachments}`);
  console.log(`✓ Email: "${subject}" arrived in Mailpit with its attachment`);
}

async function main() {
  await checkLocalStack();
  await checkS3();
  await checkEmail();
  console.log("All checks passed. Inbox: http://localhost:8025");
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
