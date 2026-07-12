#!/usr/bin/env node
/**
 * Build UE58CursorBridge via RunUAT BuildPlugin.
 * Requires UE_ROOT (or UE5_ROOT) pointing at the UE 5.8 engine directory.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ueRoot = process.env.UE_ROOT || process.env.UE5_ROOT;

if (!ueRoot) {
  console.error('[build-ue-plugin] UE_ROOT or UE5_ROOT is required');
  process.exit(1);
}

const runUat = path.join(ueRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
if (!fs.existsSync(runUat)) {
  console.error(`[build-ue-plugin] RunUAT not found: ${runUat}`);
  process.exit(1);
}

const uplugin = path.join(root, 'plugins', 'UE58CursorBridge', 'UE58CursorBridge.uplugin');
if (!fs.existsSync(uplugin)) {
  console.error(`[build-ue-plugin] Plugin descriptor missing: ${uplugin}`);
  process.exit(1);
}

const packageDir = path.join(root, 'Saved', 'UE58CursorBridge');
const args = [
  'BuildPlugin',
  `-Plugin=${uplugin}`,
  `-Package=${packageDir}`,
  '-TargetPlatforms=Win64',
  '-Rocket',
];

const cmdLine = [runUat, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
console.log(`[build-ue-plugin] ${cmdLine}`);

const result = spawnSync('cmd.exe', ['/d', '/s', '/c', cmdLine], {
  cwd: root,
  stdio: 'pipe',
  encoding: 'utf-8',
});

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
if (output.trim()) {
  const lines = output.trim().split(/\r?\n/);
  console.log(lines.slice(-40).join('\n'));
}

if (result.status !== 0) {
  console.error(`[build-ue-plugin] BuildPlugin failed (exit ${result.status ?? 'unknown'})`);
  process.exit(result.status ?? 1);
}

const hasBinary =
  fs.existsSync(path.join(packageDir, 'Binaries')) ||
  fs.existsSync(path.join(packageDir, 'HostProject', 'Plugins', 'UE58CursorBridge', 'Binaries'));
if (!hasBinary) {
  console.error(`[build-ue-plugin] No Binaries/ output under ${packageDir}`);
  process.exit(1);
}

console.log('[build-ue-plugin] OK');
