#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

/** @returns {string[]} absolute paths to *.test.mjs files */
export function listTestFiles() {
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(testDir, name))
    .sort();
}

function runTests() {
  const testFiles = listTestFiles();
  if (testFiles.length === 0) {
    console.error('[test] no *.test.mjs files found');
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  runTests();
}
