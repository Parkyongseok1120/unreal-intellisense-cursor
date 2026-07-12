#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mojibake = /[\u00C3\u00C2\u00E2][\u0080-\u00BF]|\uFFFD/;

const targets = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
      walk(full);
    } else if (/\.(ts|json|md)$/i.test(entry.name)) {
      targets.push(full);
    }
  }
}

walk(path.join(root, 'src'));
walk(path.join(root, 'snippets'));

for (const file of ['package.json', 'README.md', 'CHANGELOG.md']) {
  targets.push(path.join(root, file));
}

let failed = false;
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf-8');
  if (mojibake.test(text)) {
    console.error(`[audit-encoding] mojibake detected in ${path.relative(root, file)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`[audit-encoding] UTF-8 OK (${targets.length} files)`);
