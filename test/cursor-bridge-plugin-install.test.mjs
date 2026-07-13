import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const rpc = loadTsModule('src/editorBridge/editorBridgeRpc.ts', {
  '../platform/dataDir': () => ({
    ensureDataDir: async (r) => path.join(r, '.ue5_8cursor'),
  }),
  '../platform/workspaceMutation': () => ({
    runWithTransaction: async (_root, fn) => fn({ writeText: async () => {} }),
    mutateText: async () => {},
  }),
  '../parsers/uprojectParser': () => ({
    ensurePluginInUProject: async () => true,
  }),
  '../version': () => ({
    getExtensionVersion: () => '7.2.0',
  }),
});

function dismissKey(projectRoot) {
  const hash = crypto.createHash('sha256').update(path.resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16);
  return `ue58rider.bridgeInstallDismissed.${hash}`;
}

function isBridgePluginReady(projectRoot) {
  const uplugin = path.join(projectRoot, 'Plugins', 'UE58CursorBridge', 'UE58CursorBridge.uplugin');
  if (!fs.existsSync(uplugin)) return false;
  return rpc.isBridgePluginBinaryPresent(projectRoot);
}

describe('cursor bridge plugin install orchestrator', () => {
  it('builds stable dismiss keys per project root', () => {
    const a = dismissKey('C:/Games/MyProject');
    const b = dismissKey('c:/games/myproject');
    const c = dismissKey('C:/Games/Other');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^ue58rider\.bridgeInstallDismissed\./);
  });

  it('prefers Saved prebuilt plugin source when binaries exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-src-'));
    const saved = path.join(root, 'Saved', 'UE58CursorBridge');
    const source = path.join(root, 'plugins', 'UE58CursorBridge');
    fs.mkdirSync(path.join(saved, 'Binaries', 'Win64'), { recursive: true });
    fs.writeFileSync(path.join(saved, 'UE58CursorBridge.uplugin'), '{}');
    fs.writeFileSync(path.join(saved, 'Binaries', 'Win64', 'UE58CursorBridge.dll'), 'dll');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'UE58CursorBridge.uplugin'), '{}');

    const resolved = rpc.resolveBridgePluginSource(root);
    assert.ok(resolved);
    assert.equal(resolved.path, saved);
    assert.equal(resolved.prebuilt, true);
  });

  it('reports plugin ready only when uplugin and binary exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-ready-'));
    const pluginRoot = path.join(root, 'Plugins', 'UE58CursorBridge');
    assert.equal(isBridgePluginReady(root), false);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'UE58CursorBridge.uplugin'), '{}');
    assert.equal(isBridgePluginReady(root), false);
    fs.mkdirSync(path.join(pluginRoot, 'Binaries', 'Win64'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'Binaries', 'Win64', 'UE58CursorBridge.dll'), 'dll');
    assert.equal(isBridgePluginReady(root), true);
  });
});
