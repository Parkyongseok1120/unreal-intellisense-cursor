#!/usr/bin/env node
/**
 * Release workflow verification — static checks for Rider 60% milestone gates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const checks = [];

function pass(name) {
  checks.push({ name, ok: true });
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
}

function fileHas(rel, needle) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return false;
  return fs.readFileSync(full, 'utf-8').includes(needle);
}

if (fs.existsSync(path.join(root, '.gitattributes'))) pass('.gitattributes present');
else fail('.gitattributes present', 'missing');

if (fileHas('.github/workflows/ci.yml', 'git diff --check')) pass('CI whitespace check');
else fail('CI whitespace check', 'ci.yml missing git diff --check');

if (fileHas('scripts/build-ue-plugin.mjs', "spawnSync('cmd.exe'")) pass('safe BuildPlugin spawn');
else fail('safe BuildPlugin spawn', 'shell spawn still used');

if (fileHas('src/projectModel/buildSnapshot.ts', 'BuildSnapshot')) pass('BuildSnapshot module');
else fail('BuildSnapshot module', 'missing');

if (fileHas('src/semantic/semanticNavigation.ts', 'registerSemanticNavigation')) pass('UE semantic navigation');
else fail('UE semantic navigation', 'missing');

if (fileHas('src/uht/ueInspections.ts', 'inspectionRuleCount')) pass('UE inspections');
else fail('UE inspections', 'missing');

if (fileHas('src/testing/unrealTestExplorer.ts', 'createTestController')) pass('VS Code TestController');
else fail('VS Code TestController', 'missing');

if (fileHas('src/extension.ts', 'ue58rider.debugMultiplayer') || fileHas('src/extension.ts', 'Commands.DebugMultiplayer')) {
  pass('multiplayer command wired');
} else fail('multiplayer command wired', 'missing');

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(c.ok ? `✔ ${c.name}` : `✖ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

if (failed.length > 0) {
  console.error(`\nverify-rider-workflow: ${failed.length} check(s) failed`);
  process.exit(1);
}

console.log(`\nverify-rider-workflow: ${checks.length} checks passed`);
