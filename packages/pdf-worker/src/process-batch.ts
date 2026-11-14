// The PDF worker's core loop: one batch file → a note per user → S3 → email.
// S3 and email are passed in (deps), so tests can use fakes and no Docker is needed.

import type { Batch, BatchResult } from "../../shared/types.ts";
import type { EmailSender } from "../../shared/email.ts";
import { renderNote } from "./render-note.ts";

export type Deps = {
  readBatch: (key: string) => Promise<Batch>;
  putPdf: (key: string, pdf: Buffer) => Promise<void>;
  email: EmailSender;
};

// A basic shape check; the real test of an address is whether the mail server accepts it.
const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export async function processBatch(key: string, deps: Deps): Promise<BatchResult> {
  // Batch-level failure: if the file can't be read, throw. The whole batch gets retried (layer 4).
  const batch = await deps.readBatch(key);
  const { tradeDate } = batch;

  let sent = 0;
  const failed: BatchResult["failed"] = [];

  // One user at a time. The email provider's rate limit sets the pace, not CPU,
  // so parallelism comes from running many Lambdas, not from inside one.
  for (const user of batch.users) {
    try {
      const { pdf } = await renderNote(user, tradeDate);

      // Upload BEFORE emailing: if the email fails, the note still exists for the app/resend.
      await deps.putPdf(`notes/${tradeDate}/${user.id}.pdf`, pdf);

      if (!looksLikeEmail(user.email)) throw new Error(`invalid email "${user.email}"`);
      await deps.email.send(
        user.email,
        `Contract note for ${tradeDate}`,
        `Dear ${user.name},\n\nPlease find attached your contract note for trades on ${tradeDate}.\n\nClosing Bell Broking`,
        { filename: `contract-note-${tradeDate}.pdf`, content: pdf },
      );
      sent++;
    } catch (err) {
      // User-level failure: record it and carry on with the rest of the batch.
      failed.push({ userId: user.id, reason: (err as Error).message });
    }
  }

  return { key, sent, failed };
}
