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

  async refresh(ctx: UE5_8CursorContext): Promise<AutomationTestEntry[]> {
    if (!ctx.project) {
      this.tests = [];
      this.emitter.fire();
      return [];
    }

    // Placeholder until EditorBridge exposes Automation/Spec inventory.
    this.tests = [
      { name: `${ctx.project.name}.Smoke`, source: 'automation' },
      { name: `${ctx.project.name}.Editor`, source: 'spec' },
    ];
    this.emitter.fire();
    return this.tests;
  }

  getTests(): AutomationTestEntry[] {
    return this.tests;
  }

  async runTest(
    ctx: UE5_8CursorContext,
    settings: UE5_8CursorSettings,
    test: AutomationTestEntry,
  ): Promise<void> {
    if (!ctx.project || !ctx.engine) {
      vscode.window.showWarningMessage('UE5_8 Cursor: project and engine required to run tests.');
      return;
    }
    const filter = `${ctx.project.name}.${test.name}`;
    await vscode.window.showInformationMessage(`UE5_8 Cursor: run automation ${filter} (EditorBridge pending)`);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
