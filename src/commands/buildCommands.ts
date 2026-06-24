import * as vscode from 'vscode';
import { buildCommandLine, cleanCommandLine, formatCommandLine } from '../build/ubt';
import { spawnAsync, isUnrealEditorRunning } from '../platform/process';
import { publishBuildDiagnostics, clearBuildDiagnostics } from '../ui/buildDiagnostics';
import type { StatusBarManager } from '../ui/statusBar';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

async function runUbt(
  ctx: UE5_8CursorContext,
  cmd: { executable: string; args: string[] },
  title: string,
  statusBar?: StatusBarManager,
): Promise<boolean> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return false;
  }

  clearBuildDiagnostics(ctx);
  statusBar?.clearBuildProgress();
  let fullOutput = '';
  let success = false;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      ctx.outputChannel.show(true);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${formatCommandLine(cmd)}`);

      const capture = (line: string) => {
        fullOutput += line + '\n';
        ctx.outputChannel.appendLine(line);
        statusBar?.onBuildOutputLine(line);
      };

      const result = await spawnAsync(cmd.executable, cmd.args, {
        onStdout: capture,
        onStderr: capture,
        token,
      });

      success = result.exitCode === 0;
      publishBuildDiagnostics(ctx, fullOutput);
      statusBar?.clearBuildProgress();

      if (success) {
        const errCount = (fullOutput.match(/: error /gi) ?? []).length;
        if (errCount === 0) {
          vscode.window.showInformationMessage(`UE5_8 Cursor: ${title} 완료`);
          if (ctx.project) {
            const { refreshAllIndexes } = await import('../assets/indexCoordinator');
            void refreshAllIndexes(ctx.project.projectRoot);
          }
        }
      } else {
        const errCount = (fullOutput.match(/: error /gi) ?? []).length;
        vscode.window
          .showErrorMessage(`UE5_8 Cursor: ${title} 실패 (${errCount} errors)`, 'Problems 보기', '출력 보기')
          .then((c) => {
            if (c === 'Problems 보기') vscode.commands.executeCommand('workbench.actions.view.problems');
            if (c === '출력 보기') ctx.outputChannel.show();
          });
      }
    },
  );
  return success;
}

export async function executeBuild(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  statusBar?: StatusBarManager,
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;
  const editorRunning = await isUnrealEditorRunning();
  if (editorRunning) {
    const choice = await vscode.window.showWarningMessage(
      '에디터가 실행 중입니다. Live Coding을 사용하시겠습니까?',
      'Live Coding',
      '전체 빌드',
    );
    if (choice === 'Live Coding') {
      const { triggerLiveCoding } = await import('./liveCodingCommand');
      await triggerLiveCoding(ctx, settings);
      return;
    }
  }

  const cmd = buildCommandLine(ctx.engine, ctx.project, {
    configuration: settings.buildConfiguration,
    targetType: settings.buildTarget,
    platform: settings.platform,
    editorRunning,
  });
  await runUbt(ctx, cmd, 'Build', statusBar);
}

export async function executeRebuild(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  statusBar?: StatusBarManager,
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;
  const clean = cleanCommandLine(ctx.engine, ctx.project, {
    configuration: settings.buildConfiguration,
    targetType: settings.buildTarget,
    platform: settings.platform,
  });
  await runUbt(ctx, clean, 'Clean', statusBar);
  await executeBuild(ctx, settings, statusBar);
}

export async function executeClean(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  statusBar?: StatusBarManager,
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;
  const cmd = cleanCommandLine(ctx.engine, ctx.project, {
    configuration: settings.buildConfiguration,
    targetType: settings.buildTarget,
    platform: settings.platform,
  });
  await runUbt(ctx, cmd, 'Clean', statusBar);
}
