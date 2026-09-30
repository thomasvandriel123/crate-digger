#!/usr/bin/env node
/* eslint-disable no-console -- a CLI report */
/**
 * Performance budget: initial JavaScript <= 350 KB gzipped, three.js included after tree-shaking.
 * "Initial" = everything needed for the first interactive frame: the entry chunk plus the lazily loaded
 * scene chunk. The dev-only tuning panel is excluded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 350;
const dir = join(process.cwd(), 'dist', 'assets');
const files = readdirSync(dir).filter((f) => f.endsWith('.js') && !/devtools|lil-gui/.test(f));

let total = 0;
const rows = files.map((f) => {
  const buf = readFileSync(join(dir, f));
  const gz = gzipSync(buf, { level: 9 }).length;
  total += gz;
  return { file: f, raw: statSync(join(dir, f)).size, gz };
});
rows.sort((a, b) => b.gz - a.gz);
for (const r of rows)
  console.log(
    `${(r.gz / 1024).toFixed(1).padStart(8)} KB gz  ${(r.raw / 1024).toFixed(1).padStart(8)} KB raw  ${r.file}`,
  );
const kb = total / 1024;
console.log(`\nInitial JavaScript: ${kb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`);
if (kb > BUDGET_KB) {
  console.error('Over budget.');
  process.exit(1);
}
