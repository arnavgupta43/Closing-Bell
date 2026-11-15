// processBatch with fake S3 and a fake email sender: no Docker, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Batch } from "../../shared/types.ts";
import type { EmailSender } from "../../shared/email.ts";
import { processBatch, type Deps } from "../src/process-batch.ts";

const KEY = "batches/2026-10-16/batch-01-0001.json";

const sampleBatch = (): Batch =>
  JSON.parse(readFileSync(new URL("./sample-batch.json", import.meta.url), "utf8"));

// Fakes that remember every call in order, so tests can check what happened and when.
function fakes(batch: Batch, failEmailFor: string[] = []) {
  const calls: string[] = [];
  const email: EmailSender = {
    async send(to, _subject, _body, attachment) {
      if (failEmailFor.includes(to)) throw new Error("SMTP 550 mailbox unavailable");
      assert.equal(attachment.content.subarray(0, 5).toString(), "%PDF-");
      calls.push(`email ${to}`);
    },
  };
  const deps: Deps = {
    readBatch: async () => batch,
    putPdf: async (key) => void calls.push(`put ${key}`),
    email,
  };
  return { deps, calls };
}

test("sends a note to every valid user and reports the invalid one", async () => {
  const { deps, calls } = fakes(sampleBatch());

  const result = await processBatch(KEY, deps);

  assert.equal(result.key, KEY);
  assert.equal(result.sent, 4);
  assert.deepEqual(result.failed, [{ userId: "U1045", reason: 'invalid email "not-an-email"' }]);
  assert.equal(calls.filter((c) => c.startsWith("email")).length, 4);
});

test("uploads each PDF before emailing it", async () => {
  const { deps, calls } = fakes(sampleBatch());

  await processBatch(KEY, deps);

  const put = calls.indexOf("put notes/2026-10-16/U1042.pdf");
  const email = calls.indexOf("email user1042@example.com");
  assert.ok(put !== -1 && email !== -1 && put < email);
});

test("keeps the PDF in S3 even when the email fails", async () => {
  const { deps, calls } = fakes(sampleBatch());

  await processBatch(KEY, deps);

  // U1045 has a bad address: no email, but the note is still stored for the app.
  assert.ok(calls.includes("put notes/2026-10-16/U1045.pdf"));
});

test("one user's email error doesn't stop the rest of the batch", async () => {
  const { deps } = fakes(sampleBatch(), ["user1043@example.com"]);

  const result = await processBatch(KEY, deps);

  assert.equal(result.sent, 3);
  assert.deepEqual(
    result.failed.map((f) => f.userId),
    ["U1043", "U1045"],
  );
  assert.equal(result.failed[0].reason, "SMTP 550 mailbox unavailable");
});

test("throws when the batch file can't be read, so the whole batch can be retried", async () => {
  const { deps } = fakes(sampleBatch());
  deps.readBatch = async () => {
    throw new Error("NoSuchKey");
  };

  await assert.rejects(processBatch(KEY, deps), /NoSuchKey/);
});
