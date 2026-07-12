import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { EditorBridgeClient } from '../editorBridge/editorBridgeClient';
import { isMethodImplemented } from '../editorBridge/bridgeProtocol';

export interface AutomationTestEntry {
  name: string;
  source: 'automation' | 'spec';
  path?: string;
}

interface TestRuntimeState {
  bridge: EditorBridgeClient | undefined;
  tests: AutomationTestEntry[];
  offlineMessage: string;
  failedTests: Set<string>;
}

function automationTestUri(test: AutomationTestEntry): vscode.Uri {
  if (test.path) return vscode.Uri.file(test.path);
  return vscode.Uri.parse(`ue-automation:${encodeURIComponent(`${test.source}:${test.name}`)}`);
}

/** One VS Code TestController, with a separate durable state for every UE project. */
export class UnrealTestExplorer implements vscode.Disposable {
  private controller: vscode.TestController;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly runtimeStates = new Map<string, TestRuntimeState>();
  private activeProjectRoot: string | undefined;
  private runOutput: vscode.OutputChannel;
  private runProfile: vscode.TestRunProfile | undefined;

  constructor() {
    this.controller = vscode.tests.createTestController('ue58rider.automation', 'UE Automation');
    this.runOutput = vscode.window.createOutputChannel('UE5_8 Automation');
    this.controller.resolveHandler = async (item) => { if (!item) await this.refreshFromBridge(); };
    this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.runHandler(request, token), true);
    this.controller.createRunProfile('Rerun Failed', vscode.TestRunProfileKind.Run, (request, token) => this.rerunFailed(request, token), false);
  }

  private get state(): TestRuntimeState {
    const key = this.activeProjectRoot?.toLowerCase();
    if (!key) return { bridge: undefined, tests: [], offlineMessage: 'Editor Bridge offline; automation tests unavailable.', failedTests: new Set() };
    let state = this.runtimeStates.get(key);
    if (!state) {
      state = { bridge: undefined, tests: [], offlineMessage: 'Editor Bridge offline; automation tests unavailable.', failedTests: new Set() };
      this.runtimeStates.set(key, state);
    }
    return state;
  }

  setRuntime(projectRoot: string | undefined, bridge: EditorBridgeClient | undefined): void {
    this.activeProjectRoot = projectRoot;
    if (projectRoot) this.state.bridge = bridge;
  }

  /** Compatibility entry point for callers that already selected a runtime. */
  setBridge(bridge: EditorBridgeClient | undefined): void { this.setRuntime(this.activeProjectRoot, bridge); }
  getController(): vscode.TestController { return this.controller; }

  async refresh(ctx: UE5_8CursorContext): Promise<AutomationTestEntry[]> {
    if (!ctx.project) {
      this.activeProjectRoot = undefined;
      this.controller.items.replace([]);
      this.emitter.fire();
      return [];
    }
    this.activeProjectRoot = ctx.project.projectRoot;
    const state = this.state;
    if (state.bridge?.hasCapability('automationTests')) {
      try {
        const remote = await state.bridge.listAutomationTests();
        state.tests = remote.map((t) => ({ name: t.name, source: t.source, path: typeof t.path === 'string' ? t.path : undefined }));
        state.offlineMessage = '';
        this.rebuildTree();
        this.emitter.fire();
        return state.tests;
      } catch { /* retain the latest known project cache below */ }
    }
    state.tests = [];
    state.offlineMessage = 'Editor Bridge offline; automation tests unavailable.';
    this.controller.items.replace([]);
    this.emitter.fire();
    return state.tests;
  }

  private async refreshFromBridge(): Promise<void> {
    const state = this.state;
    if (!state.bridge?.hasCapability('automationTests')) return;
    try {
      const remote = await state.bridge.listAutomationTests();
      state.tests = remote.map((t) => ({ name: t.name, source: t.source, path: typeof t.path === 'string' ? t.path : undefined }));
      this.rebuildTree();
    } catch { /* keep this project's cached tree */ }
  }

  private rebuildTree(): void {
    const items = new Map<string, vscode.TestItem>();
    for (const test of this.state.tests) {
      const id = `${test.source}:${test.name}`;
      const item = this.controller.createTestItem(id, test.name, automationTestUri(test));
      item.description = test.source;
      items.set(id, item);
    }
    this.controller.items.replace([...items.values()]);
  }

  getTests(): AutomationTestEntry[] { return this.state.tests; }
  getOfflineMessage(): string { return this.state.offlineMessage; }

  async runTest(ctx: UE5_8CursorContext, _settings: UE5_8CursorSettings, test: AutomationTestEntry): Promise<void> {
    if (!ctx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: project required to run tests.');
      return;
    }
    this.activeProjectRoot = ctx.project.projectRoot;
    const item = this.controller.items.get(`${test.source}:${test.name}`);
    if (item && this.runProfile) {
      await this.runProfile.runHandler(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token);
      return;
    }
    vscode.window.showInformationMessage(this.state.offlineMessage);
  }

  private async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    const state = this.state;
    for (const item of this.collectTests(request)) {
      if (token.isCancellationRequested) { run.skipped(item); continue; }
      const testName = item.label;
      run.started(item);
      this.runOutput.appendLine(`[run] ${testName}`);
      if (!state.bridge?.hasCapability('automationTests')) { run.errored(item, new vscode.TestMessage(state.offlineMessage)); continue; }
      if (!isMethodImplemented('automation.status')) { run.errored(item, new vscode.TestMessage('automation.status not available on Bridge server')); continue; }
      const start = await state.bridge.runAutomationTest(testName);
      if (!start.ok) { run.failed(item, new vscode.TestMessage(start.message ?? 'Failed to start test')); state.failedTests.add(testName); continue; }
      run.appendOutput(`Started ${testName}\n`);
      const status = await state.bridge.pollAutomationStatus(testName, { timeoutMs: 120_000, token });
      if (status.state === 'passed') { run.passed(item); state.failedTests.delete(testName); this.runOutput.appendLine(`[pass] ${testName}`); }
      else if (status.state === 'failed') { run.failed(item, new vscode.TestMessage(status.message ?? 'Test failed')); state.failedTests.add(testName); this.runOutput.appendLine(`[fail] ${testName}: ${status.message ?? ''}`); }
      else if (status.state === 'cancelled' || token.isCancellationRequested) { await state.bridge.cancelAutomationTest(testName); run.skipped(item); }
      else { run.errored(item, new vscode.TestMessage(status.message ?? 'Test status unknown; not marked passed')); state.failedTests.add(testName); }
    }
    run.end();
  }

  private async rerunFailed(_request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const state = this.state;
    if (state.failedTests.size === 0) { vscode.window.showInformationMessage('UE5_8 Cursor: no failed tests to rerun.'); return; }
    const items = [...state.failedTests].map((name) => this.controller.items.get(`automation:${name}`) ?? this.controller.items.get(`spec:${name}`)).filter((item): item is vscode.TestItem => !!item);
    if (items.length === 0) { vscode.window.showInformationMessage('UE5_8 Cursor: failed tests not found in tree.'); return; }
    await this.runHandler(new vscode.TestRunRequest(items), token);
  }

  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    return request.include ? [...request.include] : [...this.controller.items].map(([, item]) => item);
  }

  dispose(): void {
    this.emitter.dispose();
    this.controller.dispose();
    this.runOutput.dispose();
    this.runtimeStates.clear();
  }
}
