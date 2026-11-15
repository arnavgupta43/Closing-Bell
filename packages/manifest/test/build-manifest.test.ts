import { test } from "node:test";
import assert from "node:assert/strict";
import type { Manifest } from "../../shared/types.ts";
import { buildManifest } from "../src/build-manifest.ts";

test("lists the date's batch files, sorted, into manifest/<date>/manifest.json", async () => {
  let saved: { key: string; manifest: Manifest } | undefined;
  let askedPrefix = "";

  const result = await buildManifest("2026-10-16", {
    listKeys: async (prefix) => {
      askedPrefix = prefix;
      return [
        "batches/2026-10-16/batch-02-0001.json",
        "batches/2026-10-16/batch-01-0002.json",
        "batches/2026-10-16/batch-01-0001.json",
        "batches/2026-10-16/notes.txt", // not a batch file
      ];
    },
    putManifest: async (key, manifest) => void (saved = { key, manifest }),
  });

  assert.equal(askedPrefix, "batches/2026-10-16/"); // trailing slash: never picks up 2026-10-160...
  assert.deepEqual(result, { manifestKey: "manifest/2026-10-16/manifest.json", files: 3 });
  assert.deepEqual(saved, {
    key: "manifest/2026-10-16/manifest.json",
    manifest: {
      tradeDate: "2026-10-16",
      files: [
        "batches/2026-10-16/batch-01-0001.json",
        "batches/2026-10-16/batch-01-0002.json",
        "batches/2026-10-16/batch-02-0001.json",
      ],
    },
  });
});

test("a day with no batch files gives an empty manifest, not an error", async () => {
  const result = await buildManifest("2026-10-18", {
    listKeys: async () => [],
    putManifest: async () => {},
  });
  assert.equal(result.files, 0);
});
