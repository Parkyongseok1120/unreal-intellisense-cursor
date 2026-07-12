import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function mockEnsureDataDir() {
  return {
    ensureDataDir: async (root) => {
      const dir = path.join(root, '.ue5_8cursor');
      await fs.promises.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../parsers/moduleLayout': () => ({
    discoverModuleLayouts: async () => [
      {
        moduleName: 'Game',
        moduleRoot: 'C:/P/Source/Game',
        publicDir: 'C:/P/Source/Game/Public',
        privateDir: 'C:/P/Source/Game/Private',
      },
    ],
  }),
  '../platform/paths': () => ({
    fileExists: async (p) => !String(p).includes('missing'),
  }),
  '../platform/workspaceMutation': () => ({
    mutateJson: async () => {},
  }),
  '../uht/reflectionIndex': () => ({
    buildReflectionIndex: async () => [
      { className: 'AMyActor', filePath: 'C:/P/Source/Game/Public/MyActor.h', properties: [], functions: [] },
    ],
  }),
  '../uht/uhtRunner': () => ({
    findUhtManifest: async () => undefined,
    parseUhtManifestInputFiles: async () => [],
  }),
  '../platform/dataDir': mockEnsureDataDir,
});

describe('semantic graph', () => {
  it('builds and persists semantic graph', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-semantic-'));
    const privateDir = path.join(root, 'Source', 'Game', 'Private');
    const publicDir = path.join(root, 'Source', 'Game', 'Public');
    fs.mkdirSync(privateDir, { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(privateDir, 'Foo.cpp'), '');

    const projectModelLocal = loadTsModule('src/projectModel/projectModelService.ts', {
      '../parsers/moduleLayout': () => ({
        discoverModuleLayouts: async () => [
          {
            moduleName: 'Game',
            moduleRoot: path.join(root, 'Source', 'Game'),
            publicDir,
            privateDir,
          },
        ],
      }),
      '../platform/paths': () => ({
        fileExists: async (p) => {
          try {
            await fs.promises.access(p);
            return true;
          } catch {
            return false;
          }
        },
      }),
      '../platform/workspaceMutation': () => ({
        mutateJson: async () => {},
      }),
      '../uht/reflectionIndex': () => ({
        buildReflectionIndex: async () => [
          { className: 'AMyActor', filePath: path.join(publicDir, 'MyActor.h'), properties: [], functions: [] },
        ],
      }),
      '../uht/uhtRunner': () => ({
        findUhtManifest: async () => undefined,
        parseUhtManifestInputFiles: async () => [],
      }),
      '../platform/dataDir': mockEnsureDataDir,
    });

    const project = {
      name: 'P',
      projectRoot: root,
      uprojectPath: path.join(root, 'P.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };

    const graph = await projectModelLocal.buildSemanticGraph(project);
    assert.equal(graph.version, 2);
    assert.equal(graph.modules.length, 1);
    assert.equal(graph.reflection.length, 1);
    assert.ok(Array.isArray(graph.symbols));

    const saved = await projectModelLocal.saveSemanticGraph(root, graph);
    assert.ok(fs.existsSync(saved));

    const loaded = await projectModelLocal.loadSemanticGraph(root);
    assert.equal(loaded?.modules[0].name, 'Game');
  });

  it('collects compile actions from project root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-compile-'));
    const db = [
      {
        file: 'C:/P/Source/Game/Private/Foo.cpp',
        command: 'clang++ -c C:/P/Source/Game/Private/Foo.cpp',
      },
    ];
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(db));

    const actions = await projectModel.collectCompileActionsFromProject(root);
    assert.equal(actions.length, 1);
    assert.ok(actions[0].hash.length > 0);
  });
});
