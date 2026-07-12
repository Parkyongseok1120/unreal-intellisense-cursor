#!/usr/bin/env node
/**
 * Structure lint only — NOT used for release scores.
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
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

if (read('src/editorBridge/bridgeProtocol.ts').includes('BRIDGE_METHODS')) pass('bridge schema registry exists');
else fail('bridge schema registry exists');

if (fs.existsSync('schemas/quality-metrics-v1.json')) pass('quality metrics schema exists');
else fail('quality metrics schema exists');

if (read('src/session/workspaceProjectRegistry.ts').includes('WorkspaceProjectRegistry')) pass('registry module exists');
else fail('registry module exists');

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(c.ok ? `✔ ${c.name}` : `✖ ${c.name}`);
}
if (failed.length > 0) process.exit(1);
console.log(`verify-structure: ${checks.length} lint checks passed`);
