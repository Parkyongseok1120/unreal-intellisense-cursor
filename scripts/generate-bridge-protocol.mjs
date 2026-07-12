#!/usr/bin/env node
/**
 * Generate bridge protocol artifacts from schemas/editor-bridge-v1.json.
 * Single source of truth — CI fails if generated output drifts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const schemaPath = path.join(root, 'schemas', 'editor-bridge-v1.json');
const outTs = path.join(root, 'src', 'editorBridge', 'bridgeProtocol.generated.ts');
const outCpp = path.join(root, 'plugins', 'UE58CursorBridge', 'Source', 'UE58CursorBridge', 'Private', 'BridgeProtocol.generated.h');

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const methods = Object.keys(schema.methods).sort();
const capabilities = [...(schema.capabilities ?? [])].sort();

const ts = `/** AUTO-GENERATED — run: node scripts/generate-bridge-protocol.mjs */
export const GENERATED_BRIDGE_METHODS = [
${methods.map((m) => `  '${m}',`).join('\n')}
] as const;

export const GENERATED_BRIDGE_CAPABILITIES = [
${capabilities.map((c) => `  '${c}',`).join('\n')}
] as const;
`;

const cppMethods = methods.map((m) => `\tTEXT("${m}")`).join(',\n');
const cpp = `#pragma once
// AUTO-GENERATED — run: node scripts/generate-bridge-protocol.mjs
static constexpr int32 BRIDGE_PROTOCOL_SCHEMA_VERSION = ${schema.version};

static const TCHAR* GGeneratedBridgeMethods[] = {
${cppMethods}
};

static constexpr int32 GGeneratedBridgeMethodCount = ${methods.length};
`;

const existingTs = fs.existsSync(outTs) ? fs.readFileSync(outTs, 'utf-8') : '';
const existingCpp = fs.existsSync(outCpp) ? fs.readFileSync(outCpp, 'utf-8') : '';

let changed = false;
if (existingTs !== ts) {
  fs.writeFileSync(outTs, ts, 'utf-8');
  changed = true;
}
if (existingCpp !== cpp) {
  fs.mkdirSync(path.dirname(outCpp), { recursive: true });
  fs.writeFileSync(outCpp, cpp, 'utf-8');
  changed = true;
}

if (process.argv.includes('--check') || process.env.CHECK_BRIDGE_PROTOCOL === '1') {
  if (existingTs !== ts || existingCpp !== cpp) {
    console.error('generate-bridge-protocol: generated files out of date — run node scripts/generate-bridge-protocol.mjs');
    process.exit(1);
  }
  console.log('generate-bridge-protocol: OK (no drift)');
  process.exit(0);
}

console.log(`generate-bridge-protocol: ${changed ? 'updated' : 'unchanged'} (${methods.length} methods)`);
