// Renders the sample user's contract note to out/sample-note.pdf so you can open and look at it.
//
//   npm run render-sample

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BatchUser } from "../packages/shared/types.ts";
import { renderNote } from "../packages/pdf-worker/src/render-note.ts";

const user: BatchUser = JSON.parse(
  readFileSync("packages/pdf-worker/test/sample-user.json", "utf8"),
);

const { pdf, hash } = await renderNote(user, "2026-10-16");

mkdirSync("out", { recursive: true });
writeFileSync("out/sample-note.pdf", pdf);
console.log(`wrote out/sample-note.pdf (${pdf.length} bytes), sha256 ${hash}`);
