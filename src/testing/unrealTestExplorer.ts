import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

export interface AutomationTestEntry {
  name: string;
  source: 'automation' | 'spec';
  path?: string;
}

export class UnrealTestExplorer implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private tests: AutomationTestEntry[] = [];
  private offlineMessage = 'Editor Bridge offline — automation tests unavailable';

  async refresh(ctx: UE5_8CursorContext): Promise<AutomationTestEntry[]> {
    if (!ctx.project) {
      this.tests = [];
      this.emitter.fire();
      return [];
    }

    this.tests = [];
    this.offlineMessage = 'Editor Bridge offline — automation tests unavailable';
    this.emitter.fire();
    return this.tests;
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
    _test: AutomationTestEntry,
  ): Promise<void> {
    if (!ctx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: project required to run tests.');
      return;
    }
    vscode.window.showInformationMessage(this.offlineMessage);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
