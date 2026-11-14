// Lambda entry point: wires the real S3 client and email sender into processBatch.
// Event: { key: "batches/2026-10-16/batch-0001.json" } (one Distributed Map item in layer 4).

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, makeS3Client } from "../../shared/s3.ts";
import { SmtpEmailSender } from "../../shared/email.ts";
import type { Batch, BatchResult } from "../../shared/types.ts";
import { processBatch } from "./process-batch.ts";

// Created once per container, outside the handler: a warm Lambda reuses them across invocations.
const s3 = makeS3Client();
const email = new SmtpEmailSender();

export async function handler(event: { key: string }): Promise<BatchResult> {
  return processBatch(event.key, {
    readBatch: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return JSON.parse(await res.Body!.transformToString()) as Batch;
    },
    putPdf: async (key, pdf) => {
      await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: pdf, ContentType: "application/pdf" }),
      );
    },
    email,
  });
}
