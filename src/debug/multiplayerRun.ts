import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import { baseCppDebuggerOptions, resolveEditorProgramPath, resolveServerExecutable } from '../platform/debug';
import { resolveDebugWorkspaceFolder } from '../commands/debugCommands';

const trackedMultiplayerSessions = new Set<string>();

export async function stopMultiplayerDebug(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (session) {
    await vscode.debug.stopDebugging(session);
  }
  trackedMultiplayerSessions.clear();
  vscode.window.showInformationMessage('UE5_8 Cursor: Multiplayer debug sessions stopped.');
}

export interface MultiplayerRunOptions {
  players: number;
  listenServer: boolean;
  dedicatedServer: boolean;
}

export async function launchMultiplayerDebug(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  options: MultiplayerRunOptions,
): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showWarningMessage('UE5_8 Cursor: project and engine required.');
    return;
  }

  const folder = resolveDebugWorkspaceFolder(ctx.project);
  if (!folder) {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: 프로젝트 루트가 workspace에 포함되어 있지 않습니다. .code-workspace로 프로젝트를 열어주세요.',
    );
    return;
  }

  const editorProgram = resolveEditorProgramPath(
    ctx.engine.root,
    settings.debugBuildConfiguration,
    settings.platform,
  );

  const { ensureDebugConfigs } = await import('../cursor/launchConfig');
  await ensureDebugConfigs({
    project: ctx.project,
    engine: ctx.engine,
    debugConfiguration: settings.debugBuildConfiguration,
    platform: settings.platform,
  });

  if (settings.debugAutoBuild) {
    const { debugLaunchEditor } = await import('../commands/debugCommands');
    const buildOnly = async () => {
      const { buildCommandLine } = await import('../build/ubt');
      const { spawnAsync } = await import('../platform/process');
      const targetType = options.dedicatedServer ? 'Server' : 'Editor';
      const cmd = buildCommandLine(ctx.engine!, ctx.project!, {
        configuration: settings.debugBuildConfiguration,
        targetType,
        platform: settings.platform,
      });
      const result = await spawnAsync(cmd.executable, cmd.args);
      return result.exitCode === 0;
    };
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'UE5_8 Cursor: Multiplayer build...' },
      buildOnly,
    );
    if (!ok) {
      vscode.window.showErrorMessage('UE5_8 Cursor: build failed — multiplayer launch aborted.');
      return;
    }
  }

  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);
  const sessions: Thenable<boolean>[] = [];

  if (options.dedicatedServer) {
    const serverExe = resolveServerExecutable(ctx.project);
    sessions.push(
      vscode.debug.startDebugging(folder, {
        ...base,
        name: `UE5_8: Dedicated Server (${ctx.project.name})`,
        request: 'launch',
        program: serverExe,
        args: [ctx.project.uprojectPath, '-log'],
        cwd: ctx.project.projectRoot,
      }),
    );
  } else {
    const listenArgs = options.listenServer
      ? ['-game', `-project=${ctx.project.uprojectPath}`, '-server', '-log']
      : ['-game', `-project=${ctx.project.uprojectPath}`, '-log'];

    sessions.push(
      vscode.debug.startDebugging(folder, {
        ...base,
        name: `UE5_8: PIE Host (${ctx.project.name})`,
        request: 'launch',
        program: editorProgram,
        args: listenArgs,
        cwd: ctx.project.projectRoot,
      }),
    );

    for (let i = 0; i < Math.max(0, options.players - 1); i++) {
      const port = 7777 + i;
      sessions.push(
        vscode.debug.startDebugging(folder, {
          ...base,
          name: `UE5_8: PIE Client ${i + 1}`,
          request: 'launch',
          program: editorProgram,
          args: ['-game', `-project=${ctx.project.uprojectPath}`, `-PIEVirtualPort=${port}`, '-log'],
          cwd: ctx.project.projectRoot,
        }),
      );
    }
  }

  for (const session of sessions) {
    const started = await session;
    if (!started) {
      await stopMultiplayerDebug();
      vscode.window.showErrorMessage('UE5_8 Cursor: failed to start one or more multiplayer debug sessions.');
      return;
    }
    if (vscode.debug.activeDebugSession?.name) {
      trackedMultiplayerSessions.add(vscode.debug.activeDebugSession.name);
    }
  }
}
