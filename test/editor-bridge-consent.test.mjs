import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

describe('cursor bridge plugin install', () => {
  it('does not copy without consent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-install-'));
    const extPlugins = path.join(root, 'ext', 'plugins', 'UE58CursorBridge');
    fs.mkdirSync(extPlugins, { recursive: true });
    fs.writeFileSync(path.join(extPlugins, 'UE58CursorBridge.uplugin'), '{}');

    const project = {
      name: 'P',
      projectRoot: path.join(root, 'proj'),
      uprojectPath: path.join(root, 'proj', 'P.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    fs.mkdirSync(project.projectRoot, { recursive: true });
    fs.writeFileSync(project.uprojectPath, JSON.stringify({ FileVersion: 3, Modules: [] }));

    const rpc = loadTsModule('src/editorBridge/editorBridgeRpc.ts', {
      '../platform/dataDir': () => ({
        ensureDataDir: async (r) => path.join(r, '.ue5_8cursor'),
      }),
      '../platform/workspaceMutation': () => ({
        runWithTransaction: async () => {
          throw new Error('should not run transaction without consent');
        },
        mutateText: async () => {},
      }),
      '../parsers/uprojectParser': () => ({
        ensurePluginInUProject: async () => false,
      }),
      '../version': () => ({
        getExtensionVersion: () => '6.6.1',
      }),
    });

    const result = await rpc.installCursorBridgePlugin(project, {
      consentGranted: false,
      extensionPath: path.join(root, 'ext'),
    });
    assert.equal(result.ok, false);
    assert.ok(!fs.existsSync(path.join(project.projectRoot, 'Plugins', 'UE58CursorBridge')));
  });

  it('ensureCursorBridgePlugin deprecated path never copies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-legacy-'));
    const project = {
      name: 'P',
      projectRoot: path.join(root, 'proj'),
      uprojectPath: path.join(root, 'proj', 'P.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    fs.mkdirSync(project.projectRoot, { recursive: true });

    const rpc = loadTsModule('src/editorBridge/editorBridgeRpc.ts', {
      '../platform/dataDir': () => ({
        ensureDataDir: async (r) => path.join(r, '.ue5_8cursor'),
      }),
      '../platform/workspaceMutation': () => ({
        runWithTransaction: async () => {
          throw new Error('legacy ensure must not copy');
        },
        mutateText: async () => {},
      }),
      '../parsers/uprojectParser': () => ({
        ensurePluginInUProject: async () => false,
      }),
      '../version': () => ({
        getExtensionVersion: () => '6.6.1',
      }),
    });

    const copied = await rpc.ensureCursorBridgePlugin(project, path.join(root, 'ext'));
    assert.equal(copied, false);
  });
});
