import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const targetResolver = loadTsModule('src/build/targetResolver.ts', {
  '../constants': () => ({
    TARGET_SUFFIXES: { Editor: 'Editor', Game: '', Client: 'Client', Server: 'Server' },
  }),
});

describe('target resolver', () => {
  it('resolves Lyra-style Editor and Game targets from Target.cs files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-target-lyra-'));
    const sourceDir = path.join(root, 'Source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'LyraEditor.Target.cs'), '');
    fs.writeFileSync(path.join(sourceDir, 'LyraGame.Target.cs'), '');
    fs.writeFileSync(path.join(sourceDir, 'LyraServer.Target.cs'), '');

    const project = {
      name: 'Lyra',
      projectRoot: root,
      uprojectPath: path.join(root, 'Lyra.uproject'),
      engineAssociation: '5.8',
      modules: [{ Name: 'LyraGame', Type: 'Runtime', LoadingPhase: 'Default' }],
    };

    assert.equal(targetResolver.resolveEditorTargetName(project), 'LyraEditor');
    assert.equal(targetResolver.resolveGameTargetName(project), 'LyraGame');
    assert.equal(targetResolver.resolveTargetName(project, 'Editor'), 'LyraEditor');
    assert.equal(targetResolver.resolveTargetName(project, 'Game'), 'LyraGame');
  });

  it('falls back to uproject basename when no Target.cs exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-target-fallback-'));
    const project = {
      name: 'MyGame',
      projectRoot: root,
      uprojectPath: path.join(root, 'MyGame.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    assert.equal(targetResolver.resolveEditorTargetName(project), 'MyGameEditor');
    assert.equal(targetResolver.resolveGameTargetName(project), 'MyGame');
  });
});
