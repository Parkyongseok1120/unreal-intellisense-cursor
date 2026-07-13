import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorContext } from '../types';
import {
  formatInstallPreview,
  installCursorBridgePlugin,
  isBridgePluginBinaryPresent,
  isCursorBridgePluginInstalled,
  listCursorBridgePluginFiles,
  resolveBridgePluginSource,
} from './editorBridgeRpc';

const DISMISS_PREFIX = 'ue58rider.bridgeInstallDismissed';

export function bridgeInstallDismissKey(projectRoot: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16);
  return `${DISMISS_PREFIX}.${hash}`;
}

export function isBridgePluginReady(projectRoot: string): boolean {
  if (!isCursorBridgePluginInstalled({ projectRoot, uprojectPath: '', name: '', engineAssociation: '', modules: [] })) {
    return false;
  }
  return isBridgePluginBinaryPresent(projectRoot);
}

export interface BridgePluginInstallResult {
  installed: boolean;
  skipped: boolean;
  message?: string;
}

export async function maybePromptInstallBridgePlugin(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
  extensionContext: vscode.ExtensionContext,
): Promise<BridgePluginInstallResult> {
  if (!ctx.project || !extensionPath) {
    return { installed: false, skipped: true };
  }

  const projectRoot = ctx.project.projectRoot;
  if (isBridgePluginReady(projectRoot)) {
    return { installed: false, skipped: true, message: 'Bridge plugin ready' };
  }

  const dismissKey = bridgeInstallDismissKey(projectRoot);
  if (extensionContext.globalState.get<boolean>(dismissKey)) {
    return { installed: false, skipped: true, message: 'Install prompt dismissed' };
  }

  if (settings.bridgeAutoInstallOnOpen) {
    return runBridgePluginInstall(ctx, settings, extensionPath, {
      consentGranted: true,
      silent: settings.bridgeAutoInstallSilent,
      bridgeContext: extensionContext,
    });
  }

  if (!settings.bridgePromptInstallOnOpen) {
    return { installed: false, skipped: true };
  }

  const files = await listCursorBridgePluginFiles(extensionPath);
  const preview = formatInstallPreview(ctx.project, extensionPath, files);
  const choice = await vscode.window.showWarningMessage(
    'Install UE58CursorBridge editor plugin into this project?',
    { modal: !settings.bridgeAutoInstallSilent, detail: preview },
    'Install',
    'Later',
    "Don't ask again",
  );

  if (choice === "Don't ask again") {
    await extensionContext.globalState.update(dismissKey, true);
    return { installed: false, skipped: true, message: 'Dismissed permanently' };
  }
  if (choice !== 'Install') {
    return { installed: false, skipped: true, message: 'Deferred' };
  }

  return runBridgePluginInstall(ctx, settings, extensionPath, {
    consentGranted: true,
    silent: false,
    bridgeContext: extensionContext,
  });
}

export async function runBridgePluginInstall(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
  options: { consentGranted: boolean; silent?: boolean; bridgeContext?: vscode.ExtensionContext },
): Promise<BridgePluginInstallResult> {
  if (!ctx.project) return { installed: false, skipped: true };

  const result = await installCursorBridgePlugin(ctx.project, {
    consentGranted: options.consentGranted,
    extensionPath,
    enableInUproject: true,
    allowUpgrade: true,
    bridgeContext: options.bridgeContext,
  });

  if (!result.ok) {
    if (!options.silent) {
      vscode.window.showErrorMessage(result.message ?? 'Failed to install UE58CursorBridge.');
    }
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Bridge plugin install failed: ${result.message ?? 'unknown'}`);
    return { installed: false, skipped: false, message: result.message };
  }

  const msg =
    result.message ??
    'UE58CursorBridge installed. Restart the Unreal Editor to load the bridge.';
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${msg}`);
  if (result.needsBuild) {
    ctx.outputChannel.appendLine('[UE5_8 Cursor] Run: UE_ROOT="<Epic UE 5.8>" npm run build:ue-plugin');
  }

  if (!options.silent) {
    vscode.window.showInformationMessage(msg);
  }

  return { installed: !!result.copied || !!result.upgraded, skipped: false, message: msg };
}

export async function maybePromptRestartEditor(
  bridgeConnected: boolean,
  pluginReady: boolean,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  if (bridgeConnected || !pluginReady) return;
  const choice = await vscode.window.showInformationMessage(
    'UE58CursorBridge is installed but the editor bridge is offline. Restart Unreal Editor to connect.',
    'OK',
  );
  if (choice) {
    outputChannel.appendLine('[UE5_8 Cursor] Waiting for editor bridge — restart Unreal Editor with this project.');
  }
}
