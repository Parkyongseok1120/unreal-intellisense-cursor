import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import { getDefaultUePlatform } from '../platform/platform';
import type { BuildConfiguration, BuildTargetType, BuildPlatform } from '../types';

export class UE5_8CursorSettings {
  get engineRoot(): string {
    return this.cfg.get<string>('engineRoot', '');
  }

  get projectFile(): string {
    return this.cfg.get<string>('projectFile', '');
  }

  get buildConfiguration(): BuildConfiguration {
    return this.cfg.get<BuildConfiguration>('buildConfiguration', 'Development');
  }

  get buildTarget(): BuildTargetType {
    return this.cfg.get<BuildTargetType>('buildTarget', 'Editor');
  }

  get platform(): BuildPlatform {
    return this.cfg.get<BuildPlatform>('platform', getDefaultUePlatform());
  }

  get autoStartLogViewer(): boolean {
    return this.cfg.get<boolean>('autoStartLogViewer', false);
  }

  get showWelcomeOnFirstOpen(): boolean {
    return this.cfg.get<boolean>('showWelcomeOnFirstOpen', true);
  }

  get llvmPath(): string {
    return this.cfg.get<string>('llvmPath', '');
  }

  get autoSetupOnOpen(): boolean {
    return this.cfg.get<boolean>('autoSetupOnOpen', true);
  }

  /** Silent bootstrap — no confirmation dialogs; status bar + Output only. */
  get autoSetupSilent(): boolean {
    return this.cfg.get<boolean>('autoSetupSilent', true);
  }

  get autoGenerateCompileCommands(): boolean {
    return this.cfg.get<boolean>('autoGenerateCompileCommands', true);
  }

  get autoWarmUnrealCacheOnOpen(): boolean {
    return this.cfg.get<boolean>('autoWarmUnrealCacheOnOpen', true);
  }

  get upsertClangdConfig(): boolean {
    return this.cfg.get<boolean>('upsertClangdConfig', true);
  }

  get liveCodingMethod(): 'keystroke' | 'disabled' {
    return this.cfg.get<'keystroke' | 'disabled'>('liveCoding.method', 'keystroke');
  }

  get hideExplorerNoise(): boolean {
    return this.cfg.get<boolean>('hideExplorerNoise', true);
  }

  /** 디버깅용 빌드 구성 — 심볼 포함 (DebugGame 권장) */
  get debugBuildConfiguration(): BuildConfiguration {
    return this.cfg.get<BuildConfiguration>('debug.buildConfiguration', 'DebugGame');
  }

  /** 디버그 시작 전 자동 빌드 */
  get debugAutoBuild(): boolean {
    return this.cfg.get<boolean>('debug.autoBuildBeforeLaunch', true);
  }

  get autoRefreshOnSourceChange(): boolean {
    return this.cfg.get<boolean>('autoRefreshOnSourceChange', true);
  }

  get mcpEnabled(): boolean {
    return this.cfg.get<boolean>('mcp.enabled', true);
  }

  get mcpPort(): number {
    return this.cfg.get<number>('mcp.port', 0);
  }

  get mcpPortDefault(): number {
    return this.cfg.get<number>('mcp.portDefault', 8000);
  }

  get contentBrowserMode(): 'hidden' | 'dedicated-view' | 'explorer-visible' {
    return this.cfg.get<'hidden' | 'dedicated-view' | 'explorer-visible'>(
      'contentBrowser.mode',
      'dedicated-view',
    );
  }

  get contentBrowserUi(): 'tree' | 'webview' | 'both' {
    return this.cfg.get<'tree' | 'webview' | 'both'>('contentBrowser.ui', 'tree');
  }

  get mcpAutoFixUproject(): boolean {
    return this.cfg.get<boolean>('mcp.autoFixUproject', false);
  }

  get experimentalAssetImportDnD(): boolean {
    return this.cfg.get<boolean>('experimental.assetImportDnD', false);
  }

  get experimentalIncrementalCompileDb(): boolean {
    return this.cfg.get<boolean>('experimental.incrementalCompileDb', false);
  }

  get experimentalHlsl(): boolean {
    return this.cfg.get<boolean>('experimental.hlsl', false);
  }

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(EXTENSION_ID);
  }

  onDidChange(callback: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(EXTENSION_ID)) {
        callback();
      }
    });
  }
}

/** @deprecated Use UE5_8CursorSettings */
export type UE58RiderSettings = UE5_8CursorSettings;
