import * as fs from 'fs';
import * as path from 'path';
import type { UEInstallation, UEProject, BuildConfiguration } from '../types';
import { buildSymbolSearchPaths, resolveGameExecutable, resolveNatvisPath } from '../platform/debug';
import { buildCommandLine, resolveTargetName } from '../build/ubt';
import { getDebuggerType, getDebuggerMIMode } from '../platform/platform';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

export const DEBUG_TASK_BUILD_EDITOR = 'ue58rider: build editor (debug)';
export const DEBUG_TASK_BUILD_GAME = 'ue58rider: build game (debug)';

export interface DebugConfigInput {
  project: UEProject;
  engine: UEInstallation;
  debugConfiguration: BuildConfiguration;
  platform: string;
}

export function buildTasksJson(input: DebugConfigInput): object {
  const editorCmd = buildCommandLine(input.engine, input.project, {
    configuration: input.debugConfiguration,
    targetType: 'Editor',
    platform: input.platform as 'Win64',
  });
  const gameCmd = buildCommandLine(input.engine, input.project, {
    configuration: input.debugConfiguration,
    targetType: 'Game',
    platform: input.platform as 'Win64',
  });

  return {
    version: '2.0.0',
    tasks: [
      {
        label: DEBUG_TASK_BUILD_EDITOR,
        type: 'shell',
        command: editorCmd.executable,
        args: editorCmd.args,
        group: { kind: 'build', isDefault: false },
        problemMatcher: ['$msCompile', 'ue58rider-msvc'],
        presentation: { reveal: 'always', panel: 'dedicated', clear: true },
      },
      {
        label: DEBUG_TASK_BUILD_GAME,
        type: 'shell',
        command: gameCmd.executable,
        args: gameCmd.args,
        group: { kind: 'build', isDefault: false },
        problemMatcher: ['$msCompile', 'ue58rider-msvc'],
        presentation: { reveal: 'always', panel: 'dedicated', clear: true },
      },
    ],
  };
}

export function buildLaunchJson(input: DebugConfigInput): object {
  const { project, engine, debugConfiguration } = input;
  const natvis = resolveNatvisPath(engine.root);
  const symbols = buildSymbolSearchPaths(project, engine);
  const gameExe = resolveGameExecutable(project);
  const editorTarget = resolveTargetName(project, 'Editor');
  const gameTarget = resolveTargetName(project, 'Game');
  const dbgType = getDebuggerType();
  const miMode = getDebuggerMIMode();

  const common: Record<string, unknown> = {
    visualizerFile: natvis,
    requireExactSource: false,
    symbolSearchPath: symbols,
    logging: { moduleLoad: false, trace: false },
  };
  if (miMode) common.MIMode = miMode;

  const makeConfig = (name: string, extra: Record<string, unknown>) => ({
    name,
    type: dbgType,
    ...extra,
    ...common,
  });

  return {
    version: '0.2.0',
    configurations: [
      makeConfig(`UE5_8: Launch ${editorTarget} (${debugConfiguration})`, {
        request: 'launch',
        program: engine.editorPath,
        args: [project.uprojectPath],
        cwd: project.projectRoot,
        stopAtEntry: false,
        preLaunchTask: DEBUG_TASK_BUILD_EDITOR,
      }),
      makeConfig('UE5_8: Attach to Unreal Editor', {
        request: 'attach',
        processId: '${command:pickProcess}',
        program: engine.editorPath,
      }),
      makeConfig(`UE5_8: Launch ${gameTarget} Standalone (${debugConfiguration})`, {
        request: 'launch',
        program: gameExe,
        args: [`-project=${project.uprojectPath}`],
        cwd: project.projectRoot,
        stopAtEntry: false,
        preLaunchTask: DEBUG_TASK_BUILD_GAME,
      }),
      makeConfig(`UE5_8: Play In Editor (${debugConfiguration})`, {
        request: 'launch',
        program: engine.editorPath,
        args: ['-game', `-project=${project.uprojectPath}`],
        cwd: project.projectRoot,
        stopAtEntry: false,
        preLaunchTask: DEBUG_TASK_BUILD_EDITOR,
      }),
    ],
  };
}

export async function ensureDebugConfigs(
  input: DebugConfigInput,
  tx?: WorkspaceMutationTransaction,
): Promise<{ launch: boolean; tasks: boolean }> {
  const launchPath = path.join(input.project.projectRoot, '.vscode', 'launch.json');
  const tasksPath = path.join(input.project.projectRoot, '.vscode', 'tasks.json');

  const generatedLaunch = buildLaunchJson(input) as { version: string; configurations: Array<{ name: string }> };
  const generatedTasks = buildTasksJson(input);

  let launchContent = JSON.stringify(generatedLaunch, null, 2) + '\n';
  let tasksContent = JSON.stringify(generatedTasks, null, 2) + '\n';

  let launchChanged = true;
  let tasksChanged = true;

  try {
    const existing = JSON.parse(await fs.promises.readFile(launchPath, 'utf-8')) as {
      configurations?: Array<{ name: string }>;
    };
    const userConfigs = (existing.configurations ?? []).filter((c) => !c.name?.startsWith('UE5_8:'));
    const merged = {
      ...generatedLaunch,
      configurations: [...generatedLaunch.configurations, ...userConfigs],
    };
    launchContent = JSON.stringify(merged, null, 2) + '\n';
    const raw = await fs.promises.readFile(launchPath, 'utf-8');
    launchChanged = raw !== launchContent;
  } catch {
    launchChanged = true;
  }

  try {
    const existing = await fs.promises.readFile(tasksPath, 'utf-8');
    tasksChanged = existing !== tasksContent;
  } catch {
    tasksChanged = true;
  }

  if (launchChanged) {
    await mutateJson(tx, input.project.projectRoot, launchPath, JSON.parse(launchContent));
  }
  if (tasksChanged) {
    await mutateJson(tx, input.project.projectRoot, tasksPath, generatedTasks);
  }

  return { launch: launchChanged, tasks: tasksChanged };
}
