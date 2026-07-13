import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const debug = loadTsModule('src/platform/debug.ts', {
  './process': () => ({ spawnAsync: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
  './paths': () => ({ fileExists: async () => true }),
  './platform': () => ({
    getHostPlatform: () => 'win32',
    resolveBinariesPlatformDir: () => 'Win64',
    getSymbolPathSeparator: () => ';',
    resolveEditorPath: (engineRoot) =>
      path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'),
  }),
});

describe('debug launch program resolution', () => {
  it('prefers DebugGame editor binary when present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-debug-'));
    const binDir = path.join(root, 'Engine', 'Binaries', 'Win64');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'UnrealEditor.exe'), '');
    const debugGame = path.join(binDir, 'UnrealEditor-Win64-DebugGame.exe');
    fs.writeFileSync(debugGame, '');

    const resolved = debug.resolveEditorProgramPath(root, 'DebugGame', 'Win64');
    assert.equal(path.normalize(resolved), path.normalize(debugGame));
  });

  it('falls back to UnrealEditor.exe when config-specific binary is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-debug-fallback-'));
    const binDir = path.join(root, 'Engine', 'Binaries', 'Win64');
    fs.mkdirSync(binDir, { recursive: true });
    const editor = path.join(binDir, 'UnrealEditor.exe');
    fs.writeFileSync(editor, '');

    const resolved = debug.resolveEditorProgramPath(root, 'DebugGame', 'Win64');
    assert.equal(path.normalize(resolved), path.normalize(editor));
  });

  it('prefers DebugGame game binary when present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-debug-game-'));
    const binDir = path.join(root, 'Binaries', 'Win64');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'MyGame.exe'), '');
    const debugGame = path.join(binDir, 'MyGame-Win64-DebugGame.exe');
    fs.writeFileSync(debugGame, '');

    const resolved = debug.resolveGameExecutable(
      { name: 'MyGame', projectRoot: root, uprojectPath: path.join(root, 'MyGame.uproject'), engineAssociation: '5.8', modules: [] },
      'DebugGame',
      'Win64',
    );
    assert.equal(path.normalize(resolved), path.normalize(debugGame));
  });
});
