// Packages the PDF worker into dist/pdf-worker.zip, the file Lambda runs.
//
//   npm run build-lambda
//
// Lambda has no TypeScript and runs no `npm install`, so the zip must be complete JavaScript:
//   index.js        our code + nodemailer + AWS SDK, bundled into one file by esbuild
//   node_modules/   pdfkit only (see below)
//
// Why pdfkit is not bundled: it finds its font files at runtime relative to its own file on
// disk (createRequire(__filename)). A bundler can't see those lookups, and the bundled code
// crashes on load. So pdfkit stays "external" and is installed as a normal package in the zip.

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const OUT_DIR = "dist/pdf-worker";
const ZIP_PATH = "dist/pdf-worker.zip";

// 1. Start clean, so nothing from an old build ends up in the zip.
rmSync("dist", { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// 2. Bundle. CommonJS output: with no package.json "type" in the zip, Node treats index.js as CJS.
await build({
  entryPoints: ["packages/pdf-worker/src/handler.ts"],
  outfile: `${OUT_DIR}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["pdfkit"],
});

// 3. Install pdfkit (and only its runtime dependencies) next to index.js.
//    Same version as the root package.json, so the Lambda renders what the unit tests render.
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  `${OUT_DIR}/package.json`,
  JSON.stringify({ private: true, dependencies: { pdfkit: rootPkg.dependencies.pdfkit } }, null, 2),
);
execSync("npm install --omit=dev --no-package-lock --no-audit --no-fund", { cwd: OUT_DIR, stdio: "inherit" });

// 4. Zip the folder. Paths inside a zip use "/" even on Windows; Lambda (Linux) needs that.
const files: Record<string, Uint8Array> = {};
function addDir(dir: string) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) addDir(path);
    else files[relative(OUT_DIR, path).replaceAll("\\", "/")] = readFileSync(path);
  }
}
addDir(OUT_DIR);
writeFileSync(ZIP_PATH, zipSync(files, { level: 9 }));

const mb = (statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
console.log(`built ${ZIP_PATH} (${Object.keys(files).length} files, ${mb} MB)`);
