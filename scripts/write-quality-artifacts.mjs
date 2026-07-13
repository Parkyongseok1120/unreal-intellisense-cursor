#!/usr/bin/env node
/**
 * Write unit-test and typecheck artifacts for collect-quality-metrics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const outDir = path.join(root, 'Saved', 'quality-metrics');
fs.mkdirSync(outDir, { recursive: true });

let typecheckOk = false;
try {
  execSync('npm run typecheck', { cwd: root, stdio: 'pipe' });
  typecheckOk = true;
} catch {
  typecheckOk = false;
}

function listTestFiles() {
  return fs
    .readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join('test', name));
}

function parseJsonReporter(output) {
  let pass = 0;
  let fail = 0;
  let total = 0;
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'test' && event.file) {
        total++;
        if (event.result?.pass) pass++;
        else fail++;
      }
    } catch {
      // ignore non-json lines
    }
  }
  return { pass, fail, total };
}

function parseTapSummary(output) {
  const passMatch = output.match(/^ℹ pass (\d+)$/m);
  const failMatch = output.match(/^ℹ fail (\d+)$/m);
  const totalMatch = output.match(/^ℹ tests (\d+)$/m);
  if (!passMatch || !failMatch || !totalMatch) return undefined;
  return {
    pass: Number(passMatch[1]),
    fail: Number(failMatch[1]),
    total: Number(totalMatch[1]),
  };
}

let pass = 0;
let fail = 0;
let total = 0;

const testFiles = listTestFiles();
const testRun = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: root,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

const combinedOutput = `${testRun.stdout ?? ''}\n${testRun.stderr ?? ''}`;
const tapCounts = parseTapSummary(combinedOutput);
if (tapCounts) {
  ({ pass, fail, total } = tapCounts);
} else {
  const jsonCounts = parseJsonReporter(combinedOutput);
  if (jsonCounts.total > 0) {
    ({ pass, fail, total } = jsonCounts);
  }
}

const report = {
  pass,
  fail,
  total,
  projectRuntimeTests: fs.existsSync(path.join(root, 'test', 'project-runtime.test.mjs')),
  stabilityTargetedTests: fs.existsSync(path.join(root, 'test', 'stability-targeted.test.mjs')),
  at: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(outDir, 'typecheck-report.json'),
  JSON.stringify({ ok: typecheckOk, at: new Date().toISOString() }, null, 2) + '\n',
);
fs.writeFileSync(path.join(outDir, 'unit-test-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`[write-quality-artifacts] typecheck=${typecheckOk} tests=${pass}/${total} fail=${fail}`);
