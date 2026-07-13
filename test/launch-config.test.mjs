import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const launchConfig = loadTsModule('src/cursor/launchConfig.ts', {
  '../platform/debug': () => ({
    buildSymbolSearchPaths: () => 'C:/Proj/Binaries/Win64;C:/UE/Engine/Binaries/Win64',
    resolveEditorProgramPath: () => 'C:/UE/Engine/Binaries/Win64/UnrealEditor-Win64-DebugGame.exe',
    resolveGameExecutable: () => 'C:/Proj/Binaries/Win64/Project_MJS-Win64-DebugGame.exe',
    resolveServerExecutable: () => 'C:/Proj/Binaries/Win64/Project_MJSServer.exe',
    resolveNatvisPath: (root) => path.join(root, 'Engine/Extras/VisualStudioDebugging/Unreal.natvis'),
  }),
  '../build/ubt': () => ({
    buildCommandLine: () => ({ executable: 'C:/UE/UBT.exe', args: ['Project_MJSEditor', 'Win64', 'DebugGame'] }),
    resolveTargetName: (_project, type) => {
      if (type === 'Editor') return 'Project_MJSEditor';
      if (type === 'Server') return 'Project_MJSServer';
      return 'Project_MJS';
    },
  }),
  '../platform/platform': () => ({
    getDebuggerType: () => 'cppvsdbg',
    getDebuggerMIMode: () => undefined,
  }),
  '../platform/workspaceMutation': () => ({
    mutateJson: async (_tx, _root, _filePath, data) => {
      await fs.promises.mkdir(path.dirname(_filePath), { recursive: true });
      await fs.promises.writeFile(_filePath, JSON.stringify(data, null, 2));
    },
  }),
});

const input = {
  project: {
    name: 'Project_MJS',
    projectRoot: 'C:/Proj',
    uprojectPath: 'C:/Proj/Project_MJS.uproject',
    engineAssociation: '5.8',
    modules: [],
  },
  engine: {
    root: 'C:/UE',
    editorPath: 'C:/UE/Engine/Binaries/Win64/UnrealEditor.exe',
    ubtPath: 'C:/UE/UBT.exe',
    version: '5.8',
    source: 'manual',
    isSourceBuild: false,
  },
  debugConfiguration: 'DebugGame',
  platform: 'Win64',
};

describe('launch config generation', () => {
  it('uses DebugGame editor binary and matching config names', () => {
    const launch = launchConfig.buildLaunchJson(input);
    const names = launch.configurations.map((c) => c.name);
    assert.ok(names.includes('UE5_8: Launch Project_MJSEditor (DebugGame)'));
    assert.ok(names.includes('UE5_8: Launch Project_MJS Standalone (DebugGame)'));
    const editor = launch.configurations.find((c) => c.name.includes('Project_MJSEditor'));
    assert.equal(editor.program, 'C:/UE/Engine/Binaries/Win64/UnrealEditor-Win64-DebugGame.exe');
    assert.equal(editor.preLaunchTask, launchConfig.DEBUG_TASK_BUILD_EDITOR);
  });

  it('omits preLaunchTask when autoBuildBeforeLaunch is false', () => {
    const launch = launchConfig.buildLaunchJson({ ...input, autoBuildBeforeLaunch: false });
    const editor = launch.configurations.find((c) => c.name.includes('Project_MJSEditor'));
    assert.equal(editor.preLaunchTask, undefined);
  });

  it('merges user tasks while preserving generated ue58rider tasks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-launch-merge-'));
    const project = { ...input.project, projectRoot: root };
    const vscodeDir = path.join(root, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(vscodeDir, 'tasks.json'),
      JSON.stringify({
        version: '2.0.0',
        tasks: [{ label: 'my-custom-task', type: 'shell', command: 'echo hi' }],
      }),
      'utf-8',
    );

    const result = await launchConfig.ensureDebugConfigs({
      ...input,
      project,
    });
    assert.equal(result.tasks, true);

    const merged = JSON.parse(fs.readFileSync(path.join(vscodeDir, 'tasks.json'), 'utf-8'));
    const labels = merged.tasks.map((t) => t.label);
    assert.ok(labels.includes(launchConfig.DEBUG_TASK_BUILD_EDITOR));
    assert.ok(labels.includes('my-custom-task'));
  });
});
