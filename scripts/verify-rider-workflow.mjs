#!/usr/bin/env node
/**
 * Behavioral workflow verify — requires quality metrics artifact from collect step.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const metricsPath = path.join(root, 'test', 'fixtures', 'quality-metrics', 'ci-baseline.json');

if (!fs.existsSync(metricsPath)) {
  console.error('verify-rider-workflow: run npm run collect:quality-metrics first');
  process.exit(1);
}

const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
const checks = [];

function pass(name) {
  checks.push({ name, ok: true });
}
function fail(name, detail) {
  checks.push({ name, ok: false, detail });
}

if (metrics.version === 1) pass('metrics schema version');
else fail('metrics schema version');

if (metrics.areas?.trust?.details?.noFalsePassContract) pass('trust metrics measured');
else fail('trust metrics measured');

if (metrics.areas?.uht?.details?.inspectionsCorpus200) pass('uht corpus in metrics');
else fail('uht corpus in metrics');

const score = spawnSync(process.execPath, ['scripts/release-scorecard.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, QUALITY_METRICS_PATH: metricsPath, SCORECARD_MODE: 'progress' },
});

if (score.status === 0) pass('scorecard accepts artifact');
else fail('scorecard accepts artifact', `exit ${score.status}`);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(c.ok ? `✔ ${c.name}` : `✖ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
if (failed.length > 0) process.exit(1);
console.log(`\nverify-rider-workflow: ${checks.length} behavioral checks passed`);
