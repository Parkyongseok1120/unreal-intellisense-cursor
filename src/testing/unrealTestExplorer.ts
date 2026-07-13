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

/** Parse the UE automation RPC name from a VS Code TestItem id. */
export function automationTestNameFromId(id: string): string | undefined {
  if (id.includes(':suite:')) return undefined;
  const match = id.match(/^(?:automation|spec):(.+)$/);
  return match?.[1];
}

export function isRunnableAutomationTestId(id: string): boolean {
  return automationTestNameFromId(id) !== undefined;
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
    this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.runHandler(request, token, false), true);
    this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => this.runHandler(request, token, true), false);
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
      const remote = await state.bridge.listAutomationTestsResult();
      if (!remote.ok) {
        state.offlineMessage = remote.error.message;
        this.emitter.fire();
        return state.tests;
      }
      state.tests = remote.value.map((t) => ({ name: t.name, source: t.source, path: typeof t.path === 'string' ? t.path : undefined }));
      state.offlineMessage = '';
        this.rebuildTree();
      this.emitter.fire();
      return state.tests;
    }
    state.offlineMessage = 'Editor Bridge offline; automation tests unavailable.';
    this.emitter.fire();
    return state.tests;
  }

  private async refreshFromBridge(): Promise<void> {
    const state = this.state;
    if (!state.bridge?.hasCapability('automationTests')) return;
    const remote = await state.bridge.listAutomationTestsResult();
    if (!remote.ok) return;
    state.tests = remote.value.map((t) => ({ name: t.name, source: t.source, path: typeof t.path === 'string' ? t.path : undefined }));
    this.rebuildTree();
  }

  private rebuildTree(): void {
    this.controller.items.replace([]);
    const suiteItems = new Map<string, vscode.TestItem>();
    for (const test of this.state.tests) {
      const id = `${test.source}:${test.name}`;
      const parts = test.name.split('.');
      const suiteName = parts.length > 1 ? parts.slice(0, -1).join('.') : test.source;
      let parent = this.controller.items;
      if (suiteName) {
        const suiteId = `${test.source}:suite:${suiteName}`;
        let suiteItem = suiteItems.get(suiteId);
        if (!suiteItem) {
          suiteItem = this.controller.createTestItem(suiteId, suiteName, vscode.Uri.parse(`ue-suite:${encodeURIComponent(suiteName)}`));
          suiteItem.description = test.source;
          suiteItems.set(suiteId, suiteItem);
          parent.add(suiteItem);
        }
        parent = suiteItem.children;
      }
      const item = this.controller.createTestItem(id, parts[parts.length - 1] ?? test.name, automationTestUri(test));
      item.description = test.path ?? test.source;
      parent.add(item);
    }
  }

  getTests(): AutomationTestEntry[] { return this.state.tests; }
  getOfflineMessage(): string { return this.state.offlineMessage; }

  async runTest(ctx: UE5_8CursorContext, _settings: UE5_8CursorSettings, test: AutomationTestEntry): Promise<void> {
    if (!ctx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: project required to run tests.');
      return;
    }
    this.activeProjectRoot = ctx.project.projectRoot;
    const item = this.findTestItemById(`${test.source}:${test.name}`);
    if (item && this.runProfile) {
      await this.runProfile.runHandler(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token);
      return;
    }
    vscode.window.showInformationMessage(this.state.offlineMessage);
  }

  private async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug = false): Promise<void> {
    const run = this.controller.createTestRun(request);
    const state = this.state;
    if (debug) run.appendOutput('Debug profile: run automation test, then attach debugger to UnrealEditor if needed.\n');
    for (const item of this.collectTests(request)) {
      if (token.isCancellationRequested) { run.skipped(item); continue; }
      const testName = automationTestNameFromId(item.id);
      if (!testName) {
        run.skipped(item);
        continue;
      }
      run.started(item);
      this.runOutput.appendLine(`[run] ${testName}`);
      if (!state.bridge?.hasCapability('automationTests')) { run.errored(item, new vscode.TestMessage(state.offlineMessage)); continue; }
      if (!isMethodImplemented('automation.status')) { run.errored(item, new vscode.TestMessage('automation.status not available on Bridge server')); continue; }
      const start = await state.bridge.runAutomationTest(testName);
      if (!start.ok) { run.failed(item, new vscode.TestMessage(start.message ?? 'Failed to start test')); state.failedTests.add(item.id); continue; }
      run.appendOutput(`Started ${testName}\n`);
      const status = await state.bridge.pollAutomationStatus(testName, { timeoutMs: 120_000, token });
      if (status.state === 'passed') {
        run.passed(item);
        state.failedTests.delete(item.id);
        this.runOutput.appendLine(`[pass] ${testName}${status.durationMs ? ` (${status.durationMs}ms)` : ''}`);
        if (status.artifactPath) run.appendOutput(`Artifact: ${status.artifactPath}\n`);
        if (debug) {
          run.appendOutput(`[debug] Attach to UnrealEditor for ${testName} post-mortem debugging.\n`);
          await vscode.commands.executeCommand('ue58rider.debugAttachEditor');
        }
      }
      else if (status.state === 'failed') {
        const msg = [
          status.message ?? 'Test failed',
          status.line ? `line ${status.line}` : undefined,
          status.durationMs ? `${status.durationMs}ms` : undefined,
        ].filter(Boolean).join(' · ');
        run.failed(item, new vscode.TestMessage(msg));
        state.failedTests.add(item.id);
        this.runOutput.appendLine(`[fail] ${testName}: ${msg}`);
        if (status.artifactPath) run.appendOutput(`Artifact: ${status.artifactPath}\n`);
      }
      else if (status.state === 'cancelled' || token.isCancellationRequested) { await state.bridge.cancelAutomationTest(testName); run.skipped(item); }
      else { run.errored(item, new vscode.TestMessage(status.message ?? 'Test status unknown; not marked passed')); state.failedTests.add(item.id); }
    }
    run.end();
  }

  private async rerunFailed(_request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const state = this.state;
    if (state.failedTests.size === 0) { vscode.window.showInformationMessage('UE5_8 Cursor: no failed tests to rerun.'); return; }
    const items = [...state.failedTests]
      .map((id) => this.findTestItemById(id))
      .filter((item): item is vscode.TestItem => !!item);
    if (items.length === 0) { vscode.window.showInformationMessage('UE5_8 Cursor: failed tests not found in tree.'); return; }
    await this.runHandler(new vscode.TestRunRequest(items), token);
  }

  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    if (request.include?.length) {
      return request.include.flatMap((item) => this.collectLeafTests(item));
    }
    return this.collectAllLeafTests();
  }

  private collectLeafTests(item: vscode.TestItem): vscode.TestItem[] {
    if (isRunnableAutomationTestId(item.id)) return [item];
    return [...item.children].flatMap(([, child]) => this.collectLeafTests(child));
  }

  private collectAllLeafTests(): vscode.TestItem[] {
    const leaves: vscode.TestItem[] = [];
    const walk = (items: vscode.TestItemCollection) => {
      for (const [, item] of items) {
        if (isRunnableAutomationTestId(item.id)) leaves.push(item);
        else walk(item.children);
      }
    };
    walk(this.controller.items);
    return leaves;
  }

  private findTestItemById(id: string): vscode.TestItem | undefined {
    const walk = (items: vscode.TestItemCollection): vscode.TestItem | undefined => {
      for (const [, item] of items) {
        if (item.id === id) return item;
        const nested = walk(item.children);
        if (nested) return nested;
      }
      return undefined;
    };
    return walk(this.controller.items);
  }

  dispose(): void {
    this.emitter.dispose();
    this.controller.dispose();
    this.runOutput.dispose();
    this.runtimeStates.clear();
  }
}
