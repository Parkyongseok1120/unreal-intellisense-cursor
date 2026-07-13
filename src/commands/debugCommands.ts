import * as vscode from 'vscode';
import * as path from 'path';
import { buildCommandLine, resolveTargetName } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { fileExists } from '../platform/paths';
import {
  baseCppDebuggerOptions,
  findUnrealEditorProcesses,
  natvisExists,
  resolveEditorProgramPath,
  resolveGameExecutable,
} from '../platform/debug';
import { getDebuggerType } from '../platform/platform';
import type { BuildConfiguration, UE5_8CursorContext, UEProject } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

const CPP_DEBUG_EXTENSION_IDS = ['anysphere.cpptools', 'ms-vscode.cpptools'];

interface DebugPreflightResult {
  ok: boolean;
  reason?: string;
  hint?: string;
  extensionId?: string;
}

/** Ensure the extension contributing cppvsdbg/cppdbg is present before launch. */
async function ensureCppDebugger(): Promise<DebugPreflightResult> {
  const extension = CPP_DEBUG_EXTENSION_IDS
    .map((id) => vscode.extensions.getExtension(id))
    .find((candidate): candidate is vscode.Extension<unknown> => !!candidate);
  if (!extension) {
    const choice = await vscode.window.showErrorMessage(
      'UE5_8 Cursor: Unreal 디버깅에는 C/C++ 디버거 확장이 필요합니다 (anysphere.cpptools 또는 ms-vscode.cpptools).',
      'C/C++ 설치',
    );
    if (choice === 'C/C++ 설치') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', 'anysphere.cpptools');
    }
    return {
      ok: false,
      reason: 'C/C++ debugger extension not installed',
      hint: 'Extensions에서 "C/C++" (anysphere.cpptools)를 설치하거나 extension pack 의존성을 설치하세요.',
    };
  }
  try {
    if (!extension.isActive) await extension.activate();
    return { ok: true, extensionId: extension.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `C/C++ debugger extension failed to activate: ${detail}`,
      hint: 'Cursor를 재시작한 뒤 C/C++ 확장이 Enabled 상태인지 확인하세요.',
      extensionId: extension.id,
    };
  }
}

function getProjectWorkspaceFolder(project: UEProject): vscode.WorkspaceFolder | undefined {
  const uri = vscode.Uri.file(project.projectRoot);
  return vscode.workspace.getWorkspaceFolder(uri);
}

async function waitForCppDebugAdapter(extensionId: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const extension = vscode.extensions.getExtension(extensionId);
    if (extension?.isActive) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
}

function editorLaunchConfigName(project: UEProject, configuration: BuildConfiguration): string {
  const editorTarget = resolveTargetName(project, 'Editor');
  return `UE5_8: Launch ${editorTarget} (${configuration})`;
}

async function waitForDebugSessionEnd(timeoutMs = 5000): Promise<void> {
  if (!vscode.debug.activeDebugSession) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const sub = vscode.debug.onDidTerminateDebugSession(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
  });
}

async function startDebugSession(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  ctx: UE5_8CursorContext,
  preflight: DebugPreflightResult,
): Promise<boolean> {
  if (vscode.debug.activeDebugSession) {
    const choice = await vscode.window.showWarningMessage(
      'UE5_8 Cursor: 이미 디버그 세션이 실행 중입니다. 종료하고 새로 시작할까요?',
      '종료 후 시작',
      '취소',
    );
    if (choice !== '종료 후 시작') return false;
    await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    await waitForDebugSessionEnd();
  }

  if (preflight.extensionId) {
    await waitForCppDebugAdapter(preflight.extensionId);
  }

  const enriched: vscode.DebugConfiguration = {
    console: 'integratedTerminal',
    environment: [],
    ...config,
  };

  let started = await vscode.debug.startDebugging(folder, enriched);
  if (started) return true;

  if (typeof enriched.name === 'string') {
    started = await vscode.debug.startDebugging(folder, enriched.name);
    if (started) return true;
  }

  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Debug config dump:\n${JSON.stringify(enriched, null, 2)}`);
  return false;
}

function getWorkspaceFolder(project?: UEProject): vscode.WorkspaceFolder | undefined {
  if (project) return getProjectWorkspaceFolder(project);
  return vscode.workspace.workspaceFolders?.[0];
}

async function preflightDebugLaunch(
  ctx: UE5_8CursorContext,
  programPath: string,
): Promise<DebugPreflightResult> {
  const folder = ctx.project ? getProjectWorkspaceFolder(ctx.project) : getWorkspaceFolder();
  if (!folder) {
    return {
      ok: false,
      reason: 'No workspace folder open',
      hint: '.code-workspace 또는 프로젝트 루트 폴더를 Cursor에서 열어 주세요.',
    };
  }

  const debuggerReady = await ensureCppDebugger();
  if (!debuggerReady.ok) return debuggerReady;

  if (!(await fileExists(programPath))) {
    return {
      ok: false,
      reason: `Program not found: ${programPath}`,
      hint: '엔진 경로(ue58rider.engineRoot)와 UE 설치가 올바른지, Editor 바이너리가 존재하는지 확인하세요.',
    };
  }

  if (!ctx.project?.uprojectPath || !(await fileExists(ctx.project.uprojectPath))) {
    return {
      ok: false,
      reason: `Project file not found: ${ctx.project?.uprojectPath ?? '(missing)'}`,
      hint: 'ue58rider.projectFile 설정과 .uproject 경로를 확인하세요.',
    };
  }

  return { ok: true, extensionId: debuggerReady.extensionId };
}

function logDebugLaunchFailure(
  ctx: UE5_8CursorContext,
  config: vscode.DebugConfiguration,
  preflight: DebugPreflightResult,
): void {
  ctx.outputChannel.show(true);
  ctx.outputChannel.appendLine('[UE5_8 Cursor] Debugger launch failed.');
  if (preflight.extensionId) {
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] C/C++ extension: ${preflight.extensionId}`);
  }
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Debug type: ${config.type}`);
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Program: ${String(config.program ?? '')}`);
  if (preflight.reason) {
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Reason: ${preflight.reason}`);
  }
}

async function showDebugLaunchFailure(
  ctx: UE5_8CursorContext,
  config: vscode.DebugConfiguration,
  preflight: DebugPreflightResult,
): Promise<void> {
  logDebugLaunchFailure(ctx, config, preflight);
  const debuggerType = getDebuggerType();
  const lines = [
    'UE5_8 Cursor: 디버거를 시작하지 못했습니다.',
    preflight.hint,
    `디버그 타입: ${debuggerType}, 프로그램: ${path.basename(String(config.program ?? ''))}`,
    preflight.extensionId
      ? `C/C++ 확장: ${preflight.extensionId}`
      : 'C/C++ 확장(anysphere.cpptools 또는 ms-vscode.cpptools) 설치가 필요할 수 있습니다.',
    'Output 패널의 UE5_8 Cursor 채널에서 상세 로그를 확인하세요.',
  ].filter(Boolean);
  vscode.window.showErrorMessage(lines.join(' '));
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

  const folder = getProjectWorkspaceFolder(ctx.project);
  if (!folder) {
    vscode.window.showErrorMessage(
      'UE5_8 Cursor: 워크스페이스 폴더가 없습니다. 프로젝트 루트 또는 .code-workspace를 열어 주세요.',
    );
    return;
  }

  const editorProgram = resolveEditorProgramPath(
    ctx.engine.root,
    settings.debugBuildConfiguration,
    settings.platform,
  );

  const preflight = await preflightDebugLaunch(ctx, editorProgram);
  if (!preflight.ok) {
    await showDebugLaunchFailure(ctx, { type: getDebuggerType(), program: editorProgram }, preflight);
    return;
  }

  if (!(await natvisExists(ctx.engine.root))) {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: Unreal.natvis를 찾을 수 없습니다. FString 등 UE 타입 조사가 제한될 수 있습니다.',
    );
  }

  await ensureDebugConfigsForProject(ctx, settings);

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
  const config: vscode.DebugConfiguration = {
    ...base,
    name: editorLaunchConfigName(ctx.project, settings.debugBuildConfiguration),
    request: 'launch',
    program: editorProgram,
    args: [ctx.project.uprojectPath],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  };

  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Starting debugger: ${editorProgram}`);
  const started = await startDebugSession(folder, config, ctx, preflight);

  if (!started) {
    await showDebugLaunchFailure(ctx, config, {
      ok: false,
      extensionId: preflight.extensionId,
      reason: 'vscode.debug.startDebugging returned false',
      hint:
        'Run and Debug 패널에서 "UE5_8: Launch ..." 구성을 직접 F5로 실행해 보세요. C/C++ 확장 재시작(Cursor Reload)도 시도해 보세요.',
    });
  }
}

export async function debugAttachEditor(
  ctx: UE5_8CursorContext,
  settings?: UE5_8CursorSettings,
): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getProjectWorkspaceFolder(ctx.project);
  if (!folder) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 워크스페이스 폴더가 없습니다.');
    return;
  }

  const configuration = settings?.debugBuildConfiguration ?? 'DebugGame';
  const editorProgram = resolveEditorProgramPath(ctx.engine.root, configuration, settings?.platform ?? 'Win64');
  const preflight = await preflightDebugLaunch(ctx, editorProgram);
  if (!preflight.ok) {
    await showDebugLaunchFailure(ctx, { type: getDebuggerType(), program: editorProgram }, preflight);
    return;
  }

  if (settings) {
    await ensureDebugConfigsForProject(ctx, settings);
  }

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
  const config: vscode.DebugConfiguration = {
    ...base,
    name: 'UE5_8: Attach to Unreal Editor',
    request: 'attach',
    processId: pid,
    program: editorProgram,
  };
  const started = await startDebugSession(folder, config, ctx, preflight);

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

  const folder = getProjectWorkspaceFolder(ctx.project);
  if (!folder) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 워크스페이스 폴더가 없습니다.');
    return;
  }

  await ensureDebugConfigsForProject(ctx, settings);

  const gameExe = resolveGameExecutable(ctx.project, settings.debugBuildConfiguration, settings.platform);
  const preflight = await preflightDebugLaunch(ctx, gameExe);
  if (!preflight.ok) {
    await showDebugLaunchFailure(ctx, { type: getDebuggerType(), program: gameExe }, preflight);
    return;
  }

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

  const base = baseCppDebuggerOptions(ctx.engine, ctx.project);
  const gameTarget = resolveTargetName(ctx.project, 'Game');
  const config: vscode.DebugConfiguration = {
    ...base,
    name: `UE5_8: Launch ${gameTarget} Standalone (${settings.debugBuildConfiguration})`,
    request: 'launch',
    program: gameExe,
    args: [`-project=${ctx.project.uprojectPath}`],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  };
  const started = await startDebugSession(folder, config, ctx, preflight);

  if (!started) {
    await showDebugLaunchFailure(ctx, config, {
      ok: false,
      extensionId: preflight.extensionId,
      reason: 'vscode.debug.startDebugging returned false',
      hint: 'Game 실행 파일이 DebugGame으로 빌드되었는지 확인하세요.',
    });
  }
}

export async function debugPIE(ctx: UE5_8CursorContext, settings: UE5_8CursorSettings): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  const folder = getProjectWorkspaceFolder(ctx.project);
  if (!folder) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 워크스페이스 폴더가 없습니다.');
    return;
  }

  const editorProgram = resolveEditorProgramPath(
    ctx.engine.root,
    settings.debugBuildConfiguration,
    settings.platform,
  );
  const preflight = await preflightDebugLaunch(ctx, editorProgram);
  if (!preflight.ok) {
    await showDebugLaunchFailure(ctx, { type: getDebuggerType(), program: editorProgram }, preflight);
    return;
  }

  await ensureDebugConfigsForProject(ctx, settings);

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
  const config: vscode.DebugConfiguration = {
    ...base,
    name: `UE5_8: Play In Editor (${settings.debugBuildConfiguration})`,
    request: 'launch',
    program: editorProgram,
    args: ['-game', `-project=${ctx.project.uprojectPath}`],
    cwd: ctx.project.projectRoot,
    stopAtEntry: false,
  };
  const started = await startDebugSession(folder, config, ctx, preflight);
  if (!started) {
    await showDebugLaunchFailure(ctx, config, {
      ok: false,
      extensionId: preflight.extensionId,
      reason: 'vscode.debug.startDebugging returned false',
      hint: 'Run and Debug 패널에서 PIE 구성을 직접 실행해 보세요.',
    });
  }
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
