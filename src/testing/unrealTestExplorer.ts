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

function automationTestUri(test: AutomationTestEntry): vscode.Uri {
  if (test.path) return vscode.Uri.file(test.path);
  return vscode.Uri.parse(`ue-automation:${encodeURIComponent(`${test.source}:${test.name}`)}`);
}

export class UnrealTestExplorer implements vscode.Disposable {
  private controller: vscode.TestController;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private tests: AutomationTestEntry[] = [];
  private offlineMessage = 'Editor Bridge offline — automation tests unavailable';
  private bridge: EditorBridgeClient | undefined;
  private runOutput: vscode.OutputChannel;
  private runProfile: vscode.TestRunProfile | undefined;
  private readonly failedTests = new Set<string>();

  constructor() {
    this.controller = vscode.tests.createTestController('ue58rider.automation', 'UE Automation');
    this.runOutput = vscode.window.createOutputChannel('UE5_8 Automation');
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.refreshFromBridge();
    };
    this.runProfile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(request, token),
      true,
    );
    this.controller.createRunProfile(
      'Rerun Failed',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.rerunFailed(request, token),
      false,
    );
  }

  setBridge(bridge: EditorBridgeClient | undefined): void {
    this.bridge = bridge;
  }

  getController(): vscode.TestController {
    return this.controller;
  }

  async refresh(ctx: UE5_8CursorContext): Promise<AutomationTestEntry[]> {
    if (!ctx.project) {
      this.tests = [];
      this.controller.items.replace([]);
      this.emitter.fire();
      return [];
    }

    if (this.bridge?.hasCapability('automationTests')) {
      try {
        const remote = await this.bridge.listAutomationTests();
        this.tests = remote.map((t) => ({
          name: t.name,
          source: t.source,
          path: typeof t.path === 'string' ? t.path : undefined,
        }));
        this.offlineMessage = '';
        this.rebuildTree();
        this.emitter.fire();
        return this.tests;
      } catch {
        // fall through
      }
    }

    this.tests = [];
    this.offlineMessage = 'Editor Bridge offline — automation tests unavailable';
    this.controller.items.replace([]);
    this.emitter.fire();
    return this.tests;
  }

  private async refreshFromBridge(): Promise<void> {
    if (this.bridge?.hasCapability('automationTests')) {
      try {
        const remote = await this.bridge.listAutomationTests();
        this.tests = remote.map((t) => ({
          name: t.name,
          source: t.source,
          path: typeof t.path === 'string' ? t.path : undefined,
        }));
        this.rebuildTree();
      } catch {
        // keep cached
      }
    }
  }

  private rebuildTree(): void {
    const items = new Map<string, vscode.TestItem>();
    for (const test of this.tests) {
      const id = `${test.source}:${test.name}`;
      const item = this.controller.createTestItem(id, test.name, automationTestUri(test));
      item.description = test.source;
      items.set(id, item);
    }
    this.controller.items.replace([...items.values()]);
  }

  getTests(): AutomationTestEntry[] {
    return this.tests;
  }

  getOfflineMessage(): string {
    return this.offlineMessage;
  }

  async runTest(
    ctx: UE5_8CursorContext,
    _settings: UE5_8CursorSettings,
    test: AutomationTestEntry,
  ): Promise<void> {
    if (!ctx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: project required to run tests.');
      return;
    }

    const id = `${test.source}:${test.name}`;
    const item = this.controller.items.get(id);
    if (item && this.runProfile) {
      await this.runProfile.runHandler(
        new vscode.TestRunRequest([item]),
        new vscode.CancellationTokenSource().token,
      );
      return;
    }

    vscode.window.showInformationMessage(this.offlineMessage);
  }

  private async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    const queue = this.collectTests(request);

    for (const item of queue) {
      if (token.isCancellationRequested) {
        run.skipped(item);
        continue;
      }

      const testName = item.label;
      run.started(item);
      this.runOutput.appendLine(`[run] ${testName}`);

      if (!this.bridge?.hasCapability('automationTests')) {
        run.errored(item, new vscode.TestMessage(this.offlineMessage));
        continue;
      }

      if (!isMethodImplemented('automation.status')) {
        run.errored(item, new vscode.TestMessage('automation.status not available on Bridge server'));
        continue;
      }

      const start = await this.bridge.runAutomationTest(testName);
      if (!start.ok) {
        run.failed(item, new vscode.TestMessage(start.message ?? 'Failed to start test'));
        this.failedTests.add(testName);
        continue;
      }

      run.appendOutput(`Started ${testName}\n`);

      const status = await this.bridge.pollAutomationStatus(testName, { timeoutMs: 120_000, token });
      if (status.state === 'passed') {
        run.passed(item);
        this.failedTests.delete(testName);
        this.runOutput.appendLine(`[pass] ${testName}`);
      } else if (status.state === 'failed') {
        run.failed(item, new vscode.TestMessage(status.message ?? 'Test failed'));
        this.failedTests.add(testName);
        this.runOutput.appendLine(`[fail] ${testName}: ${status.message ?? ''}`);
      } else if (status.state === 'cancelled' || token.isCancellationRequested) {
        await this.bridge.cancelAutomationTest(testName);
        run.skipped(item);
      } else {
        run.errored(item, new vscode.TestMessage(status.message ?? 'Test status unknown — not marked passed'));
        this.failedTests.add(testName);
      }
    }

    run.end();
  }

  private async rerunFailed(_request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    if (this.failedTests.size === 0) {
      vscode.window.showInformationMessage('UE5_8 Cursor: no failed tests to rerun.');
      return;
    }
    const items = [...this.failedTests]
      .map((name) => this.controller.items.get(`automation:${name}`) ?? this.controller.items.get(`spec:${name}`))
      .filter((item): item is vscode.TestItem => !!item);
    if (items.length === 0) {
      vscode.window.showInformationMessage('UE5_8 Cursor: failed tests not found in tree.');
      return;
    }
    await this.runHandler(new vscode.TestRunRequest(items), token);
  }

  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    if (request.include) return [...request.include];
    return [...this.controller.items].map(([, item]) => item);
  }

  dispose(): void {
    this.emitter.dispose();
    this.controller.dispose();
    this.runOutput.dispose();
    this.failedTests.clear();
  }
}
