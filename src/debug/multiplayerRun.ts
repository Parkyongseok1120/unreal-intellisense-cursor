import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

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

  const launchPath = vscode.Uri.file(`${ctx.project.projectRoot}/.vscode/launch.json`);
  const configName = options.dedicatedServer
    ? 'UE5_8 Cursor: Dedicated Server'
    : `UE5_8 Cursor: PIE x${options.players}`;

  await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
    type: 'cppvsdbg',
    name: configName,
    request: 'launch',
    preLaunchTask: settings.debugAutoBuild ? 'UE5_8 Cursor: Build Editor' : undefined,
    console: 'integratedTerminal',
    args: options.dedicatedServer
      ? [`${ctx.project.name}`, '-server', '-log']
      : [`${ctx.project.name}`, `-game`, `-PIEVirtualPort=7777`, `-log`],
  } as vscode.DebugConfiguration);
}
