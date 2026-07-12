#!/usr/bin/env node
/** Real UE Editor Bridge E2E. Requires a UE 5.8 self-hosted runner. */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ueRoot = process.env.UE_ROOT || process.env.UE5_ROOT;
const requireE2e = /^(1|true)$/i.test(process.env.REQUIRE_UE_E2E || '');
const allowSkip = process.env.ALLOW_UE_E2E_SKIP === '1';
const outMetrics = process.env.UE_E2E_METRICS_PATH || path.join(root, 'Saved', 'quality-metrics', 'ue-e2e.json');
const fixtureRoot = path.join(root, 'test', 'fixtures', 'synthetic-ue-project');
const runRoot = path.join(root, 'Saved', 'ue-e2e', 'Synthetic');
const timeoutMs = Number(process.env.UE_E2E_TIMEOUT_MS || 300_000);
const rpcTimeoutMs = Number(process.env.UE_E2E_RPC_TIMEOUT_MS || 10_000);

function fail(message) {
  throw new Error(`[ue-editor-e2e] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  fail(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function rpc(descriptor, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const request = http.request({
      hostname: '127.0.0.1', port: descriptor.port, path: '/rpc', method: 'POST', timeout: rpcTimeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${descriptor.token}` },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          const json = JSON.parse(text);
          if (json.error) reject(new Error(`${method}: ${json.error.message || json.error.code}`));
          else resolve(json.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${method}: timeout`)));
    request.on('error', reject);
    request.end(body);
  });
}

function findPluginArtifact() {
  const packageRoot = path.join(root, 'Saved', 'UE58CursorBridge');
  const candidates = [
    packageRoot,
    path.join(packageRoot, 'HostProject', 'Plugins', 'UE58CursorBridge'),
    path.join(packageRoot, 'UE58CursorBridge'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'UE58CursorBridge.uplugin')));
}

function prepareProject() {
  const plugin = findPluginArtifact();
  if (!plugin) fail('BuildPlugin artifact missing; run npm run build:ue-plugin first');
  fs.rmSync(path.join(root, 'Saved', 'ue-e2e'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runRoot), { recursive: true });
  fs.cpSync(fixtureRoot, runRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}Intermediate${path.sep}`) && !source.includes(`${path.sep}Saved${path.sep}`) });
  fs.cpSync(plugin, path.join(runRoot, 'Plugins', 'UE58CursorBridge'), { recursive: true });
  const projectPath = path.join(runRoot, 'Synthetic.uproject');
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  // This fixture's C++ module declarations are intentionally static-analysis
  // fixtures and have no compilable source target. Make the E2E clone a
  // blueprint-only project so the packaged Editor plugin can load on its own.
  delete project.Modules;
  // The synthetic fixture intentionally references a nested plugin for static
  // project-model tests, but it does not ship that plugin descriptor. The E2E
  // clone must be independently launchable, so enable only the packaged Bridge.
  project.Plugins = [{ Name: 'UE58CursorBridge', Enabled: true }];
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2) + '\n', 'utf8');
  return projectPath;
}

function stopEditor(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function main() {
  if (!ueRoot) {
    if (requireE2e) fail('UE_ROOT is required on a self-hosted UE runner');
    if (allowSkip) return console.log('[ue-editor-e2e] SKIP: UE_ROOT not set');
    return console.log('[ue-editor-e2e] SKIP: UE_ROOT not set');
  }
  const editorCmd = path.join(ueRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
  const editor = fs.existsSync(editorCmd) ? editorCmd : path.join(ueRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  if (!fs.existsSync(editor)) fail(`Editor not found: ${editor}`);
  const projectPath = prepareProject();
  const editorProcess = spawn(editor, [projectPath, '-unattended', '-nop4', '-nosplash', '-nullrhi', '-NoSound', '-log'], { cwd: runRoot, windowsHide: true });
  const descriptorPath = path.join(runRoot, '.ue5_8cursor', 'editor-bridge.json');
  try {
    const descriptor = await waitFor(() => {
      if (!fs.existsSync(descriptorPath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
      return parsed.port && parsed.token && parsed.projectId === 'Synthetic' ? parsed : undefined;
    }, 'Editor Bridge descriptor');
    const checks = [];
    // The descriptor is written while the Editor finishes its project-target
    // discovery. On a cold machine that can temporarily block HTTP dispatch,
    // so wait for a responsive endpoint rather than treating the first 10 s
    // request timeout as a bridge failure.
    const rpcReady = (method, params = {}) => waitFor(
      () => rpc(descriptor, method, params),
      `Editor Bridge ${method} RPC`,
    );
    const handshake = await rpcReady('handshake', { client: 'ue-e2e', version: 1 });
    checks.push(handshake?.ok === true && Array.isArray(handshake.capabilities));
    const ping = await rpcReady('ping');
    checks.push(ping?.pong === true);
    const assets = await rpcReady('assetRegistry.list', { limit: 1 });
    checks.push(Array.isArray(assets?.assets) && typeof assets?.hasMore === 'boolean');
    const tests = await rpcReady('automation.list');
    checks.push(Array.isArray(tests?.tests));
    const ratio = checks.filter(Boolean).length / checks.length;
    const metrics = { version: 1, generatedAt: new Date().toISOString(), source: 'ue-editor-e2e', areas: {
      bridge: { accuracy: ratio, completeness: ratio, resilience: ratio, performance: ratio, verification: ratio, e2ePassed: ratio === 1, details: { checks: checks.length, passed: checks.filter(Boolean).length } },
      ci: { accuracy: ratio, completeness: ratio, resilience: ratio, performance: ratio, verification: ratio, e2ePassed: ratio === 1 },
    }};
    if (ratio !== 1) fail(`Bridge checks failed: ${checks.map((ok, i) => ok ? '' : i + 1).filter(Boolean).join(',')}`);
    fs.mkdirSync(path.dirname(outMetrics), { recursive: true });
    fs.writeFileSync(outMetrics, JSON.stringify(metrics, null, 2) + '\n', 'utf8');
    console.log(`[ue-editor-e2e] OK: ${checks.length}/${checks.length} checks; metrics=${outMetrics}`);
  } finally {
    stopEditor(editorProcess);
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
