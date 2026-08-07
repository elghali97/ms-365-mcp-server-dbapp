#!/usr/bin/env node

// Build guard: ensure the generated Graph clients exist before `tsup` runs.
//
// `src/generated/client.ts` and `client-beta.ts` are produced by `npm run generate`
// (download Graph OpenAPI specs -> trim -> openapi-zod-client). They are gitignored,
// so they are absent on a fresh checkout and — importantly — on the Databricks Apps
// build, which runs `npm install` + `npm run build` but never `npm run generate`.
//
// This script runs as `prebuild`. It regenerates the clients only when a target file
// is missing, so:
//   - Local / CI builds where the files already exist stay fast (no download, no npx).
//   - The Databricks Apps build generates them automatically during `npm run build`.
//
// Requires network egress (raw.githubusercontent.com for the specs, npm for
// `npx openapi-zod-client`), which is available during the platform's install/build
// phase. Pass --force upstream via `npm run generate -- --force` to refresh specs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const generatedDir = path.join(rootDir, 'src', 'generated');

const requiredFiles = [
  path.join(generatedDir, 'client.ts'),
  path.join(generatedDir, 'client-beta.ts'),
];

const missing = requiredFiles.filter((file) => !existsSync(file));

if (missing.length === 0) {
  console.log('[prebuild] Generated Graph clients present; skipping generation.');
  process.exit(0);
}

console.log(
  `[prebuild] Generated Graph client(s) missing (${missing
    .map((f) => path.relative(rootDir, f))
    .join(', ')}); running generation...`
);

const result = spawnSync(process.execPath, [path.join(__dirname, 'generate-graph-client.mjs')], {
  stdio: 'inherit',
  cwd: rootDir,
});

if (result.status !== 0) {
  console.error('[prebuild] Graph client generation failed.');
  process.exit(result.status ?? 1);
}
