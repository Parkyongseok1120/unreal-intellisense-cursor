import * as vscode from 'vscode';
import { parseBuildProgress } from '../parsers/buildProgressParser';
import { probeMcpEndpoint } from '../cursor/mcpConfig';
import { getIndexCounts } from '../assets/indexCoordinator';
import { Commands } from '../constants';
import type { CompileDbIndexPlan, IntelliSenseMode } from '../cursor/bootstrapProject';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

export class StatusBarManager implements vscode.Disposable {
  private readonly mainItem: vscode.StatusBarItem;
  private readonly intelliSenseItem: vscode.StatusBarItem;
  private readonly editorItem: vscode.StatusBarItem;
  private readonly mcpItem: vscode.StatusBarItem;
  private readonly assetsItem: vscode.StatusBarItem;
  private readonly uhtItem: vscode.StatusBarItem;
  private readonly buildItem: vscode.StatusBarItem;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private editorRunning = false;
  private mcpConnected = false;
  private mcpPort = 8000;
  private lastMcpCheck = 0;
  private indexCounts = { assets: 0, reflection: 0 };
  private intelliSenseMode: IntelliSenseMode = 'missing';
  private provisionalDb = false;
  private compileParity = 1;
  private compileParitySynthetic = false;
  private modelStatus: 'ready' | 'partial' | 'stale' | 'missing' = 'missing';
  private modelProvenance = 'unknown';
  private bridgeConnected = false;
  private indexPlan: CompileDbIndexPlan | undefined;
  private promotedPluginCount = 0;

  constructor() {
    this.mainItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.mainItem.command = 'ue58rider.showProjectInfo';

    this.intelliSenseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.intelliSenseItem.command = Commands.GenerateCompileCommands;

    this.editorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.editorItem.command = 'ue58rider.debugAttachEditor';

    this.mcpItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.mcpItem.command = 'ue58rider.showMcpDiagnostics';

    this.assetsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.assetsItem.command = 'ue58rider.showContentBrowser';

    this.uhtItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    this.uhtItem.command = 'ue58rider.refreshUhtIntellisense';

    this.buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
    this.buildItem.hide();
  }

  startPolling(): void {
    void this.pollEditorState();
    this.pollTimer = setInterval(() => void this.pollEditorState(), 5000);
  }

  setIntelliSense(mode: IntelliSenseMode, options?: { provisional?: boolean }): void {
    this.intelliSenseMode = mode;
    this.provisionalDb = options?.provisional ?? mode === 'partial';
    this.updateIntelliSenseItem();
  }

  setCompileParity(parity: number, synthetic: boolean, options?: { status?: 'ready' | 'partial' | 'stale' | 'missing'; provenance?: string }): void {
    this.compileParity = parity;
    this.compileParitySynthetic = synthetic;
    if (options?.status) this.modelStatus = options.status;
    if (options?.provenance) this.modelProvenance = options.provenance;
    if (synthetic) this.provisionalDb = true;
    this.updateIntelliSenseItem();
  }

  setBridgeStatus(info: { connected: boolean }): void {
    this.bridgeConnected = info.connected;
    this.updateMcpItem();
  }

  setIndexPlan(plan: CompileDbIndexPlan | undefined, promotedPluginCount = this.promotedPluginCount): void {
    this.indexPlan = plan;
    this.promotedPluginCount = promotedPluginCount;
    this.updateIntelliSenseItem();
  }

  setBuildProgress(current: number, total: number): void {
    const pct = Math.round((current / total) * 100);
    this.buildItem.text = `$(loading~spin) Build ${current}/${total} (${pct}%)`;
    this.buildItem.show();
  }

  clearBuildProgress(): void {
    this.buildItem.hide();
  }

  onBuildOutputLine(line: string): void {
    const p = parseBuildProgress(line);
    if (p) this.setBuildProgress(p.current, p.total);
  }

  private async pollEditorState(): Promise<void> {
    const { isUnrealEditorRunning } = await import('../platform/process');
    const wasRunning = this.editorRunning;
    this.editorRunning = await isUnrealEditorRunning();
    if (wasRunning !== this.editorRunning) this.updateEditorItem();

    const now = Date.now();
    if (now - this.lastMcpCheck > 30_000) {
      this.lastMcpCheck = now;
      this.mcpConnected = await probeMcpEndpoint(this.mcpPort, 500);
      this.updateMcpItem();
    }
  }

  async update(ctx: UE5_8CursorContext, settings: UE5_8CursorSettings): Promise<void> {
    if (!ctx.project) {
      this.mainItem.text = '$(game) UE5_8: No Project';
      this.mainItem.show();
      this.intelliSenseItem.hide();
      this.editorItem.hide();
      this.mcpItem.hide();
      this.assetsItem.hide();
      this.uhtItem.hide();
      return;
    }
    const engineLabel = ctx.engine ? `UE${ctx.engine.version}` : 'No Engine';
    this.mainItem.text = `$(game) ${ctx.project.name} | ${engineLabel} | ${settings.buildConfiguration}`;
    this.mainItem.show();
    this.updateIntelliSenseItem();
    this.mcpPort = settings.mcpPort || settings.mcpPortDefault;
    this.indexCounts = await getIndexCounts(ctx.project.projectRoot);
    this.updateEditorItem();
    this.updateMcpItem();
    this.updateIndexItems();
  }

  private updateIntelliSenseItem(): void {
    const parityPct = Math.round(this.compileParity * 100);
    const parityNote = this.compileParitySynthetic
      ? `Compile parity: ${parityPct}% (synthetic DB — advisory only)`
      : `Compile parity: ${parityPct}%`;
    const modelNote = `Model: ${this.modelStatus} (${this.modelProvenance})`;
    const indexNote = this.indexPlan
      ? this.indexPlan.pluginTus > 0
        ? [
            `Project model: ready`,
            `Project source indexing: ${this.indexPlan.projectTus} TU(s)`,
            `Project usable: yes`,
            `Plugin indexing: lazy (${this.indexPlan.pluginTus} TU(s), ${this.promotedPluginCount} promoted)`,
          ].join('\n')
        : [
            `Project model: ready`,
            `Project source indexing: ${this.indexPlan.projectTus} TU(s)`,
            `Project usable: yes`,
            `Plugin indexing: none`,
          ].join('\n')
      : undefined;

    switch (this.intelliSenseMode) {
      case 'ready':
        this.intelliSenseItem.text = this.indexPlan?.pluginTus
          ? '$(check) IntelliSense: Project Ready'
          : '$(check) IntelliSense: Ready';
        this.intelliSenseItem.tooltip = [
          'compile_commands.json + clangd ready.',
          modelNote,
          parityNote,
          indexNote,
        ].filter((line): line is string => !!line).join('\n');
        break;
      case 'partial':
        this.intelliSenseItem.text = `$(warning) IntelliSense: ${this.modelStatus === 'stale' ? 'Stale' : 'Provisional'}`;
        this.intelliSenseItem.tooltip =
          `Synthetic/provisional compile database — clangd advisories may differ from UBT/MSVC build results. Run an Editor build for authoritative flags.\n${modelNote}\n${parityNote}`;
        break;
      default:
        this.intelliSenseItem.text = '$(error) IntelliSense: Missing';
        this.intelliSenseItem.tooltip = `Run Setup or Refresh IntelliSense.\n${parityNote}`;
        break;
    }
    this.intelliSenseItem.show();
  }

  private updateEditorItem(): void {
    if (this.editorRunning) {
      this.editorItem.text = '$(debug-alt) Editor';
      this.editorItem.show();
    } else {
      this.editorItem.hide();
    }
  }

  private updateMcpItem(): void {
    const bridge = this.bridgeConnected ? ' Bridge:on' : '';
    this.mcpItem.text = this.mcpConnected ? `$(plug) MCP:${this.mcpPort}${bridge}` : `$(plug) MCP:off${bridge}`;
    this.mcpItem.show();
  }

  private updateIndexItems(): void {
    this.assetsItem.text = `$(database) Assets:${this.indexCounts.assets}`;
    this.assetsItem.show();
    this.uhtItem.text = `$(symbol-class) UHT:${this.indexCounts.reflection}`;
    this.uhtItem.show();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.mainItem.dispose();
    this.intelliSenseItem.dispose();
    this.editorItem.dispose();
    this.mcpItem.dispose();
    this.assetsItem.dispose();
    this.uhtItem.dispose();
    this.buildItem.dispose();
  }
}
