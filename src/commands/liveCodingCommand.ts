import * as vscode from 'vscode';
import { spawnAsync, isUnrealEditorRunning } from '../platform/process';
import { getHostPlatform } from '../platform/platform';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

async function sendLiveCodingKeystroke(): Promise<boolean> {
  const script = [
    "$ws = New-Object -ComObject wscript.shell",
    "$activated = $false",
    "foreach ($title in @('Unreal Editor', 'Unreal Engine')) {",
    "  if ($ws.AppActivate($title)) { $activated = $true; break }",
    "}",
    "if (-not $activated) { exit 1 }",
    "Start-Sleep -Milliseconds 300",
    "$ws.SendKeys('^%{F11}')",
    "exit 0",
  ].join('; ');

  try {
    const result = await spawnAsync('powershell', ['-NoProfile', '-Command', script], { shell: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function triggerLiveCodingViaMcp(): Promise<boolean> {
  const { mcpCallLogical } = await import('../blueprint/mcpBlueprintBridge');
  const result = await mcpCallLogical('liveCodingCompile', {});
  return result.ok;
}

export async function triggerLiveCoding(ctx: UE5_8CursorContext, settings: UE5_8CursorSettings): Promise<void> {
  if (settings.liveCodingMethod === 'disabled') {
    vscode.window.showInformationMessage('UE5_8 Cursor: Live Coding이 비활성화되어 있습니다.');
    return;
  }

  const running = await isUnrealEditorRunning();
  if (!running) {
    vscode.window.showWarningMessage('UE5_8 Cursor: Unreal Editor가 실행 중이 아닙니다.');
    return;
  }

  ctx.outputChannel.appendLine('[UE5_8 Cursor] Triggering Live Coding...');

  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'UE5_8 Cursor: Live Coding...' },
    async () => {
      if (await triggerLiveCodingViaMcp()) return true;
      if (getHostPlatform() === 'win32') return sendLiveCodingKeystroke();
      return false;
    },
  );

  if (ok) {
    vscode.window.showInformationMessage('UE5_8 Cursor: Live Coding 컴파일 트리거됨');
  } else if (getHostPlatform() !== 'win32') {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: Live Coding은 Mac/Linux에서 MCP 연결이 필요합니다. 에디터에서 AllToolsets + LiveCoding toolset을 활성화하거나 에디터 UI의 Live Coding 버튼을 사용하세요.',
    );
  } else {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: Live Coding 자동 트리거 실패. 에디터에서 Ctrl+Alt+F11 또는 Live Coding 버튼을 사용하세요.',
    );
  }
}
