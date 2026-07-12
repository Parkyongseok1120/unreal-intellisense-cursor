#!/usr/bin/env node
/**
 * Release scorecard — reads measured quality-metrics artifact only.
 * Weights: accuracy 35%, completeness 25%, resilience 20%, performance 10%, verification 10%.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const metricsPath =
  process.env.QUALITY_METRICS_PATH ||
  path.join(root, 'test', 'fixtures', 'quality-metrics', 'ci-baseline.json');

const WEIGHTS = { accuracy: 35, completeness: 25, resilience: 20, performance: 10, verification: 10 };
const MIN_SUB = { accuracy: 28, completeness: 20, resilience: 16, performance: 7, verification: 8 };
const AREA_MIN = {
  trust: 60,
  schemas: 60,
  buildSnapshot: 60,
  bridge: 55,
  semantic: 40,
  uht: 45,
  testing: 50,
  workflow: 50,
  projectRuntime: 50,
  ci: 55,
};

function loadMetrics() {
  if (!fs.existsSync(metricsPath)) {
    console.error(`release-scorecard: missing artifact ${metricsPath}`);
    console.error('Run: npm run collect:quality-metrics');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
}

function scoreArea(area) {
  if (area.capReason) return Math.min(59, Math.round(computeRaw(area) * 100));
  const raw = computeRaw(area);
  return Math.round(raw * 100);
}

function computeRaw(area) {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    sum += (area[k] ?? 0) * (w / 100);
  }
  return sum;
}

function subScoresOk(area, total) {
  if (area.capReason) return false;
  const subs = {
    accuracy: Math.round((area.accuracy ?? 0) * WEIGHTS.accuracy),
    completeness: Math.round((area.completeness ?? 0) * WEIGHTS.completeness),
    resilience: Math.round((area.resilience ?? 0) * WEIGHTS.resilience),
    performance: Math.round((area.performance ?? 0) * WEIGHTS.performance),
    verification: Math.round((area.verification ?? 0) * WEIGHTS.verification),
  };
  return (
    subs.accuracy >= MIN_SUB.accuracy &&
    subs.completeness >= MIN_SUB.completeness &&
    subs.resilience >= MIN_SUB.resilience &&
    subs.performance >= MIN_SUB.performance &&
    subs.verification >= MIN_SUB.verification &&
    total >= 80
  );
}

function passesArea(area, min, releaseMode) {
  if (area.capReason) return false;
  // A release claim requires an actual UE/extension evidence artifact for every
  // scored area. Unit fixtures alone may support progress reporting, never 80%.
  if (releaseMode && area.e2ePassed !== true) return false;
  const total = scoreArea(area);
  if (total < min) return false;
  if (releaseMode) return subScoresOk(area, total);
  return true;
}

const metrics = loadMetrics();
let failed = 0;
const progressMode = process.env.SCORECARD_MODE === 'progress';
const releaseMode = process.env.SCORECARD_MODE === 'release' || !progressMode;

for (const [id, area] of Object.entries(metrics.areas)) {
  const min = AREA_MIN[id] ?? 60;
  const total = scoreArea(area);
  const ok = passesArea(area, min, releaseMode);
  const cap = area.capReason ? ` (cap: ${area.capReason})` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${total}% (min ${min}%)${cap}`);
  if (!ok && !(progressMode && id !== 'ci')) failed++;
}

if (progressMode) {
  const ci = metrics.areas.ci;
  const ciTotal = scoreArea(ci ?? {});
  if (!ci || ciTotal < (AREA_MIN.ci ?? 55)) {
    console.error('release-scorecard progress: ci area below threshold');
    process.exit(1);
  }
  console.log('\nrelease-scorecard: progress mode — artifact valid, ci gate passed');
  process.exit(0);
}

if (failed > 0) {
  console.error(`\nrelease-scorecard: ${failed} area(s) below threshold`);
  process.exit(1);
}

console.log('\nrelease-scorecard: all areas meet measured thresholds');
