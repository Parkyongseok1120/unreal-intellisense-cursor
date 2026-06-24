import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';

export async function launchEditorDetached(ctx: UE5_8CursorContext): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Launching: ${ctx.engine.editorPath}`);
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Project: ${ctx.project.uprojectPath}`);

  try {
    const proc = spawn(ctx.engine.editorPath, [ctx.project.uprojectPath], {
      detached: true,
      stdio: 'ignore',
      cwd: ctx.project.projectRoot,
    });
    proc.unref();
    vscode.window.showInformationMessage('UE5_8 Cursor: Unreal Editor 실행 중');
  } catch (err) {
    vscode.window.showErrorMessage(`UE5_8 Cursor: 에디터 실행 실패 — ${err}`);
  }
}
