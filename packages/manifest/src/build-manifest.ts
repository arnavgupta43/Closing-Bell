// BuildManifest: list every batch file Extract wrote for the date and save the list as one file.
// Runs once, AFTER all extractors finished, so it sees the complete set and nobody writes it at
// the same time (parallel extractors appending to one file would overwrite each other's entries).

import type { Manifest } from "../../shared/types.ts";

export type ManifestDeps = {
  listKeys: (prefix: string) => Promise<string[]>;
  putManifest: (key: string, manifest: Manifest) => Promise<void>;
};

export const manifestKey = (tradeDate: string) => `manifest/${tradeDate}/manifest.json`;

export async function buildManifest(tradeDate: string, deps: ManifestDeps) {
  const keys = await deps.listKeys(`batches/${tradeDate}/`);

  // Only batch files; sorted so the manifest is the same however the listing came back.
  const files = keys.filter((k) => k.endsWith(".json")).sort();

  const key = manifestKey(tradeDate);
  await deps.putManifest(key, { tradeDate, files });

  // This return value is what Step Functions passes to the next step (the Map, layer 4).
  return { manifestKey: key, files: files.length };
}
