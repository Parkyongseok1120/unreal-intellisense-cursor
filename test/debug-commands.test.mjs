import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

function loadDebugCommands(workspaceFolders) {
  return loadTsModule('src/commands/debugCommands.ts', {
    vscode: () => ({
      Uri: {
        file: (fsPath) => ({ fsPath }),
      },
      workspace: {
        workspaceFolders,
        getWorkspaceFolder: (uri) =>
          workspaceFolders?.find((folder) => folder.uri.fsPath === uri.fsPath),
      },
      extensions: { getExtension: () => undefined },
      window: {
        showErrorMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showQuickPick: async () => undefined,
        withProgress: async (_opts, task) => task(),
      },
      debug: {
        activeDebugSession: undefined,
        startDebugging: async () => false,
        stopDebugging: async () => {},
        onDidTerminateDebugSession: () => ({ dispose: () => {} }),
      },
      commands: { executeCommand: async () => {} },
      ProgressLocation: { Notification: 1 },
    }),
    '../build/ubt': () => ({
      buildCommandLine: () => ({ executable: 'ubt', args: [] }),
      resolveTargetName: (_project, type) => (type === 'Editor' ? 'MyGameEditor' : 'MyGame'),
    }),
    '../platform/process': () => ({ spawnAsync: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    '../platform/paths': () => ({ fileExists: async () => true }),
    '../platform/debug': () => debug,
    '../platform/platform': () => ({ getDebuggerType: () => 'cppvsdbg' }),
    '../cursor/launchConfig': () => ({ ensureDebugConfigs: async () => ({ launch: true, tasks: true }) }),
  });
}

describe('debug attach helpers', () => {
  it('matches editor process by full uproject path', () => {
    const uproject = 'C:/Games/MyGame/MyGame.uproject';
    const process = {
      pid: 1234,
      name: 'UnrealEditor.exe',
      commandLine: '"C:/UE/Engine/Binaries/Win64/UnrealEditor.exe" "C:/Games/MyGame/MyGame.uproject"',
    };
    assert.equal(debug.editorProcessMatchesProject(process, uproject), true);
  });

  it('matches editor process by -project argument', () => {
    const uproject = 'C:/Games/MyGame/MyGame.uproject';
    const process = {
      pid: 5678,
      name: 'UnrealEditor.exe',
      commandLine: 'UnrealEditor.exe -project=C:/Games/MyGame/MyGame.uproject',
    };
    assert.equal(debug.editorProcessMatchesProject(process, uproject), true);
  });

  it('filters editor processes to the active uproject', () => {
    const uproject = 'C:/Games/MyGame/MyGame.uproject';
    const processes = [
      { pid: 1, name: 'UnrealEditor.exe', commandLine: 'UnrealEditor.exe -project=C:/Other/Other.uproject' },
      { pid: 2, name: 'UnrealEditor.exe', commandLine: 'UnrealEditor.exe -project=C:/Games/MyGame/MyGame.uproject' },
    ];
    const filtered = debug.filterEditorProcessesByProject(processes, uproject);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].pid, 2);
  });

  it('falls back to all processes when command lines are unavailable', () => {
    const processes = [
      { pid: 1, name: 'UnrealEditor.exe' },
      { pid: 2, name: 'UnrealEditor.exe' },
    ];
    const filtered = debug.filterEditorProcessesByProject(processes, 'C:/Games/MyGame/MyGame.uproject');
    assert.deepEqual(filtered, processes);
  });
});

describe('resolveDebugWorkspaceFolder', () => {
  const project = {
    name: 'MyGame',
    projectRoot: 'C:/Games/MyGame',
    uprojectPath: 'C:/Games/MyGame/MyGame.uproject',
    engineAssociation: '5.8',
    modules: [],
  };

  it('returns exact workspace folder when project root is open', () => {
    const folder = { uri: { fsPath: 'C:/Games/MyGame' }, name: 'MyGame', index: 0 };
    const commands = loadDebugCommands([folder]);
    const resolved = commands.resolveDebugWorkspaceFolder(project);
    assert.equal(resolved, folder);
  });

  it('returns ancestor workspace folder for nested multi-root layouts', () => {
    const parent = { uri: { fsPath: 'C:/Games' }, name: 'Games', index: 0 };
    const commands = loadDebugCommands([parent]);
    const resolved = commands.resolveDebugWorkspaceFolder(project);
    assert.equal(resolved, parent);
  });

  it('returns synthetic folder when project is outside workspace roots', () => {
    const commands = loadDebugCommands([]);
    const resolved = commands.resolveDebugWorkspaceFolder(project);
    assert.equal(resolved.name, 'MyGame');
    assert.equal(resolved.index, -1);
    assert.equal(resolved.uri.fsPath, project.projectRoot);
  });
});
