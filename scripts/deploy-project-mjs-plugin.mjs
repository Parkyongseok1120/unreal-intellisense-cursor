#!/usr/bin/env node
/**
 * Deploy built UE58CursorBridge plugin into Project_MJS for gate E2E.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const projectRoot = process.env.PROJECT_MJS_ROOT
  ?? path.resolve(root, '..', 'Project_MJS');
const uproject = path.join(projectRoot, 'Project_MJS.uproject');

if (!fs.existsSync(uproject)) {
  console.log(`[deploy-project-mjs-plugin] skip — Project_MJS not found at ${projectRoot}`);
  process.exit(0);
}

const candidates = [
  path.join(root, 'Saved', 'UE58CursorBridge'),
  path.join(root, 'plugins', 'UE58CursorBridge'),
];

const src = candidates.find((dir) => fs.existsSync(path.join(dir, 'UE58CursorBridge.uplugin')));
if (!src) {
  console.error('[deploy-project-mjs-plugin] bundled/built plugin not found');
  process.exit(1);
}

const dest = path.join(projectRoot, 'Plugins', 'UE58CursorBridge');
fs.mkdirSync(path.dirname(dest), { recursive: true });

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

if (fs.existsSync(dest)) {
  console.log(`[deploy-project-mjs-plugin] already installed at ${dest}`);
} else {
  copyTree(src, dest);
  console.log(`[deploy-project-mjs-plugin] copied ${src} -> ${dest}`);
}

const raw = JSON.parse(fs.readFileSync(uproject, 'utf-8'));
if (!raw.Plugins) raw.Plugins = [];
if (!raw.Plugins.some((p) => p.Name === 'UE58CursorBridge')) {
  raw.Plugins.push({ Name: 'UE58CursorBridge', Enabled: true });
  fs.writeFileSync(uproject, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  console.log('[deploy-project-mjs-plugin] enabled UE58CursorBridge in .uproject');
}

console.log('[deploy-project-mjs-plugin] OK');
