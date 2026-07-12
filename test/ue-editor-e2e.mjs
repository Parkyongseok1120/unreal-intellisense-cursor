#!/usr/bin/env node
/**
 * UE Editor E2E — runs on self-hosted runner with UE 5.8 when UE_ROOT is set.
 */
const ueRoot = process.env.UE_ROOT || process.env.UE5_ROOT;

if (!ueRoot) {
  console.log('[ue-editor-e2e] SKIP — UE_ROOT not set (self-hosted runner only)');
  process.exit(0);
}

console.log('[ue-editor-e2e] TODO: full editor handshake E2E requires automated Editor launch');
console.log('[ue-editor-e2e] Gate 5 placeholder — plugin-build + bridge contract tests cover CI today');
process.exit(0);
