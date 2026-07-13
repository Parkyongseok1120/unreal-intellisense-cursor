import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function vscodeMock() {
  class Uri {
    constructor(fsPath) {
      this.fsPath = path.resolve(fsPath);
      this.scheme = 'file';
    }
    static file(fsPath) {
      return new Uri(fsPath);
    }
  }
  return { Uri };
}

const { WorkspaceProjectRegistry } = loadTsModule('src/session/workspaceProjectRegistry.ts', {
  vscode: vscodeMock,
  './projectSession': () => ({
    ProjectSession: class {
      dispose() {}
    },
  }),
  '../editorBridge/editorBridgeClient': () => ({
    EditorBridgeClient: class {
      constructor(root) {
        this.root = root;
      }
      dispose() {}
    },
  }),
});

function sampleProject(name, root) {
  return {
    name,
    projectRoot: root,
    uprojectPath: path.join(root, `${name}.uproject`),
    engineAssociation: '5.8',
    modules: [{ name, type: 'Runtime', loadingPhase: 'Default' }],
  };
}

describe('workspace project runtime registry', () => {
  const gameA = path.join('C:', 'Workspaces', 'GameA');
  const gameB = path.join('C:', 'Workspaces', 'GameB');
  const nested = path.join(gameA, 'Plugins', 'MyPlugin');

  it('resolves runtime by URI using longest matching project root', () => {
    const registry = new WorkspaceProjectRegistry();
    registry.ensure(sampleProject('GameA', gameA));
    registry.ensure(sampleProject('MyPlugin', nested));
    const hit = registry.getByUri(vscodeMock().Uri.file(path.join(nested, 'Source', 'MyPlugin', 'Private', 'Foo.cpp')));
    assert.equal(hit?.project.name, 'MyPlugin');
  });

  it('returns active runtime only when a single project is registered', () => {
    const registry = new WorkspaceProjectRegistry();
    registry.ensure(sampleProject('GameA', gameA));
    assert.equal(registry.getActive()?.project.name, 'GameA');
    registry.ensure(sampleProject('GameB', gameB));
    assert.equal(registry.getActive(), undefined);
    registry.setActive(gameB);
    assert.equal(registry.getActive()?.project.name, 'GameB');
  });

  it('disposes nested projects when a workspace folder is removed', () => {
    const registry = new WorkspaceProjectRegistry();
    registry.ensure(sampleProject('GameA', gameA));
    registry.ensure(sampleProject('MyPlugin', nested));
    registry.setActive(gameA);
    registry.disposeUnder(gameA);
    assert.equal(registry.listRoots().length, 0);
    assert.ok(!registry.getActive());
  });

  it('matches project roots case-insensitively on Windows', () => {
    const registry = new WorkspaceProjectRegistry();
    registry.ensure(sampleProject('GameA', gameA));
    const alt = gameA.replace('GameA', 'gamea');
    assert.ok(registry.getByRoot(alt));
  });

  it('updates engine and project metadata on ensure without duplicating runtimes', () => {
    const registry = new WorkspaceProjectRegistry();
    registry.ensure(sampleProject('GameA', gameA), { root: 'C:/UE_5.8', version: '5.8' });
    registry.ensure(sampleProject('GameA', gameA), { root: 'C:/UE_5.8', version: '5.8' });
    assert.equal(registry.listRoots().length, 1);
    assert.equal(registry.getByRoot(gameA)?.engine?.root, 'C:/UE_5.8');
  });
});
