#!/usr/bin/env node
/**
 * Release scorecard — per-area minimum thresholds for 7.0 ship gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();

const AREAS = [
  { id: 'trust', min: 60, probe: () => fs.existsSync('src/editorBridge/bridgeProtocol.ts') },
  { id: 'schemas', min: 60, probe: () => fs.existsSync('schemas/editor-bridge-v1.json') },
  { id: 'buildSnapshot', min: 60, probe: () => readIncludes('src/projectModel/buildSnapshot.ts', 'authoritativeActions') },
  { id: 'bridge', min: 55, probe: () => readIncludes('plugins/UE58CursorBridge/Source/UE58CursorBridge/Private/CursorBridgeHttpServer.cpp', 'automation.status') },
  { id: 'semantic', min: 40, probe: () => readIncludes('src/semantic/semanticNavigation.ts', 'semanticNavigationEnabled') },
  { id: 'uht', min: 45, probe: () => readIncludes('src/uht/ueInspections.ts', 'enabled = false') },
  { id: 'testing', min: 50, probe: () => readIncludes('src/testing/unrealTestExplorer.ts', 'failedTests') },
  { id: 'workflow', min: 50, probe: () => readIncludes('src/debug/multiplayerRun.ts', 'baseCppDebuggerOptions') },
];

function readIncludes(rel, needle) {
  return fs.readFileSync(path.join(root, rel), 'utf-8').includes(needle);
}

let failed = 0;
for (const area of AREAS) {
  const score = area.probe() ? area.min : 0;
  const ok = score >= area.min;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${area.id}: ${score}% (min ${area.min}%)`);
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(`\nrelease-scorecard: ${failed} area(s) below threshold`);
  process.exit(1);
}

console.log('\nrelease-scorecard: all areas meet minimum threshold');
