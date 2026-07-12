#!/usr/bin/env node
/**
 * Behavioral Rider 7.0 workflow verification (Gate 5).
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

if (read('src/semantic/semanticNavigation.ts').includes('semanticNavigationEnabled')) pass('semantic navigation gated');
else fail('semantic navigation gated');

if (read('src/uht/ueInspections.ts').includes('enabled = false')) pass('inspections default off');
else fail('inspections default off');

if (!read('src/testing/unrealTestExplorer.ts').includes("return { state: 'passed' }")) pass('no false test pass fallback');
else fail('no false test pass fallback', 'pollAutomationStatus still false-passes');

if (read('src/testing/unrealTestExplorer.ts').includes('failedTests')) pass('failed test set tracked');
else fail('failed test set tracked');

if (read('src/editorBridge/bridgeProtocol.ts').includes('CPP_BRIDGE_METHODS')) pass('bridge protocol registry');
else fail('bridge protocol registry');

if (read('plugins/UE58CursorBridge/Source/UE58CursorBridge/Private/CursorBridgeHttpServer.cpp').includes('automation.status')) {
  pass('C++ automation.status');
} else fail('C++ automation.status');

if (read('src/projectModel/buildSnapshot.ts').includes('snapshotVersion')) pass('BuildSnapshot v2');
else fail('BuildSnapshot v2');

if (read('src/session/workspaceProjectRegistry.ts').includes('WorkspaceProjectRegistry')) pass('project runtime registry');
else fail('project runtime registry');

if (read('src/debug/multiplayerRun.ts').includes('baseCppDebuggerOptions')) pass('multiplayer uses debug stack');
else fail('multiplayer uses debug stack');

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(c.ok ? `✔ ${c.name}` : `✖ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

if (failed.length > 0) {
  console.error(`\nverify-rider-workflow: ${failed.length} check(s) failed`);
  process.exit(1);
}

console.log(`\nverify-rider-workflow: ${checks.length} behavioral checks passed`);
