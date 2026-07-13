#!/usr/bin/env node
/**
 * Gate 5/6 verification — runs corpus benchmarks and release scorecard.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status ?? 1;
}

const steps = [
  ['npm', ['test']],
  ['node', ['--test', 'test/cursor-bridge-plugin-install.test.mjs']],
  ['node', ['--test', 'test/bridge-rpc-contract.test.mjs']],
  ['node', ['scripts/deploy-project-mjs-plugin.mjs']],
  ['node', ['--test', 'test/project-mjs-navigation.test.mjs']],
  ['node', ['--test', 'test/project-mjs-uht.test.mjs']],
  ['node', ['scripts/benchmark-navigation.mjs']],
  ['node', ['scripts/benchmark-uht.mjs']],
  ['node', ['scripts/collect-quality-metrics.mjs']],
  ['node', ['scripts/release-scorecard.mjs']],
];

process.env.SCORECARD_MODE = process.env.SCORECARD_MODE || 'progress';

let failed = false;
for (const [cmd, args] of steps) {
  const code = run(cmd, args);
  if (code !== 0) {
    console.error(`[gate-verify] failed: ${cmd} ${args.join(' ')}`);
    failed = true;
    break;
  }
}

const baselinePath = path.join(root, 'test', 'fixtures', 'quality-metrics', 'ci-baseline.json');
if (fs.existsSync(baselinePath)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const semantic = baseline.areas?.semantic;
  const uht = baseline.areas?.uht;
  console.log(`[gate-verify] semantic accuracy=${semantic?.accuracy} e2e=${semantic?.e2ePassed}`);
  console.log(`[gate-verify] uht accuracy=${uht?.accuracy} e2e=${uht?.e2ePassed}`);
}

process.exit(failed ? 1 : 0);
