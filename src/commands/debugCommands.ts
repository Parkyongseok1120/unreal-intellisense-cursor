import * as vscode from 'vscode';
import * as path from 'path';
import { buildCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import {
  baseCppDebuggerOptions,
  findUnrealEditorProcesses,
  natvisExists,
  resolveGameExecutable,
} from '../platform/debug';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

const CPP_DEBUG_EXTENSION_IDS = ['anysphere.cpptools', 'ms-vscode.cpptools'];

/** Ensure the extension contributing cppvsdbg/cppdbg is present before launch. */
async function ensureCppDebugger(): Promise<boolean> {
  const extension = CPP_DEBUG_EXTENSION_IDS
    .map((id) => vscode.extensions.getExtension(id))
    .find((candidate): candidate is vscode.Extension<unknown> => !!candidate);
  if (!extension) {
    const choice = await vscode.window.showErrorMessage(
      'UE5_8 Cursor: C/C++ debugger extension is required for Unreal debugging.',
      'Install C/C++ Debugger',
    );
    if (choice === 'Install C/C++ Debugger') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', 'anysphere.cpptools');
    }
    return false;
  }
  try {
    if (!extension.isActive) await extension.activate();
    return true;
  } catch {
    vscode.window.showErrorMessage('UE5_8 Cursor: C/C++ debugger extension could not be activated.');
    return false;
  }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function runDebugBuild(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  target: 'Editor' | 'Game',
): Promise<boolean> {
  if (!ctx.project || !ctx.engine) return false;

  const cmd = buildCommandLine(ctx.engine, ctx.project, {
    configuration: settings.debugBuildConfiguration,
    targetType: target,
    platform: settings.platform,
  });

  ctx.outputChannel.show(true);
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Debug build (${target})...`);

  const result = await spawnAsync(cmd.executable, cmd.args, {
    onStdout: (l) => ctx.outputChannel.appendLine(l),
    onStderr: (l) => ctx.outputChannel.appendLine(l),
  });

  return result.exitCode === 0;
}

export async function debugLaunchEditor(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getWorkspaceFolder();
  if (!folder) return;
  if (!(await ensureCppDebugger())) return;

  if (!(await natvisExists(ctx.engine.root))) {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: Unreal.natvis를 찾을 수 없습니다. FString 등 UE 타입 조사가 제한될 수 있습니다.',
    );
  }

  if (settings.debugAutoBuild) {
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'UE5_8 Cursor: Debug 빌드 중...' },
      () => runDebugBuild(ctx, settings, 'Editor'),
    );
    if (!ok) {
      vscode.window.showErrorMessage('UE5_8 Cursor: Debug 빌드 실패 — 디버깅을 중단합니다.');
      return;
    }
  }

  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);
  const started = await vscode.debug.startDebugging(folder, {
    ...base,
    name: `UE5_8: Launch ${ctx.project.name}Editor`,
    request: 'launch',
    program: ctx.engine.editorPath,
    args: [ctx.project.uprojectPath],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  });

  if (!started) {
    vscode.window.showErrorMessage(
      'UE5_8 Cursor: 디버거 시작 실패. C/C++ 확장(anysphere.cpptools)이 설치되어 있는지 확인하세요.',
    );
  }
}

export async function debugAttachEditor(ctx: UE5_8CursorContext): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getWorkspaceFolder();
  if (!folder) return;
  if (!(await ensureCppDebugger())) return;

  const processes = await findUnrealEditorProcesses();
  if (processes.length === 0) {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: 실행 중인 Unreal Editor가 없습니다. 먼저 에디터를 실행하세요.',
      '에디터 실행',
    ).then((choice) => {
      if (choice === '에디터 실행') {
        vscode.commands.executeCommand('ue58rider.launchEditor');
      }
    });
    return;
  }

  let pid = processes[0].pid;
  if (processes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      processes.map((p) => ({ label: `UnrealEditor.exe (PID ${p.pid})`, pid: p.pid })),
      { placeHolder: '디버깅할 에디터 프로세스 선택' },
    );
    if (!picked) return;
    pid = picked.pid;
  }

  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);
  const started = await vscode.debug.startDebugging(folder, {
    ...base,
    name: 'UE5_8: Attach to Unreal Editor',
    request: 'attach',
    processId: pid,
    program: ctx.engine.editorPath,
  });

  if (started) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: Unreal Editor (PID ${pid})에 디버거 연결됨`);
  } else {
    vscode.window.showErrorMessage('UE5_8 Cursor: Attach 실패. DebugGame 빌드인지 확인하세요.');
  }
}

export async function debugLaunchGame(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getWorkspaceFolder();
  if (!folder) return;
  if (!(await ensureCppDebugger())) return;

  if (settings.debugAutoBuild) {
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'UE5_8 Cursor: Game Debug 빌드 중...' },
      () => runDebugBuild(ctx, settings, 'Game'),
    );
    if (!ok) {
      vscode.window.showErrorMessage('UE5_8 Cursor: Game Debug 빌드 실패');
      return;
    }
  }

  const gameExe = resolveGameExecutable(ctx.project);
  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);

  await vscode.debug.startDebugging(folder, {
    ...base,
    name: `UE5_8: Launch ${ctx.project.name}`,
    request: 'launch',
    program: gameExe,
    args: [`-project=${ctx.project.uprojectPath}`],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  });
}

export async function debugPIE(ctx: UE5_8CursorContext, settings: UE5_8CursorSettings): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getWorkspaceFolder();
  if (!folder) return;
  if (!(await ensureCppDebugger())) return;

  if (settings.debugAutoBuild) {
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'UE5_8 Cursor: PIE Debug 빌드 중...' },
      () => runDebugBuild(ctx, settings, 'Editor'),
    );
    if (!ok) {
      vscode.window.showErrorMessage('UE5_8 Cursor: PIE Debug 빌드 실패');
      return;
    }
  }

  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);
  await vscode.debug.startDebugging(folder, {
    ...base,
    name: `UE5_8: PIE ${ctx.project.name}`,
    request: 'launch',
    program: ctx.engine.editorPath,
    args: ['-game', `-project=${ctx.project.uprojectPath}`],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  });
}

/** Run and Debug 패널에서 기본 구성 선택 후 F5 */
export async function openDebugPanel(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.debug');
}

export async function ensureDebugConfigsForProject(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
): Promise<{ launch: boolean; tasks: boolean } | null> {
  if (!ctx.project || !ctx.engine) return null;

  const { ensureDebugConfigs } = await import('../cursor/launchConfig');
  return ensureDebugConfigs({
    project: ctx.project,
    engine: ctx.engine,
    debugConfiguration: settings.debugBuildConfiguration,
    platform: settings.platform,
  });
}
