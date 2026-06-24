import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { UE5_8CursorSettings } from '../config/settings';

export async function openContentBrowserByUiMode(
  projectRoot: string,
  settings: UE5_8CursorSettings,
  onOpenAsset: (path: string) => void,
  extensionContext?: vscode.ExtensionContext,
  mode?: 'tree' | 'webview' | 'both',
): Promise<void> {
  const ui = mode ?? settings.contentBrowserUi;

  if (ui === 'tree' || ui === 'both') {
    await vscode.commands.executeCommand('workbench.view.extension.ue58rider-content');
  }

  if (ui === 'webview' || ui === 'both') {
    const { showContentBrowserWebview } = await import('./contentBrowserWebview');
    await showContentBrowserWebview(projectRoot, onOpenAsset, extensionContext, settings);
  }
}

export function createOpenAssetHandler(): (path: string) => void {
  return (p) => void vscode.commands.executeCommand(Commands.OpenAsset, p);
}
