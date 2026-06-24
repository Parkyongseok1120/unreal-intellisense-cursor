import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import { buildCommandLine, cleanCommandLine, generateClangDatabaseCommandLine } from '../build/ubt';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorTaskDefinition } from '../types';

export class UE5_8CursorTaskProvider implements vscode.TaskProvider {
  static readonly type = 'ue58rider';

  constructor(
    private readonly getCtx: () => UE5_8CursorContext,
    private readonly getSettings: () => UE5_8CursorSettings,
  ) {}

  provideTasks(): vscode.Task[] {
    const ctx = this.getCtx();
    const settings = this.getSettings();
    if (!ctx.project || !ctx.engine) return [];

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];

    const defs: Array<{ action: UE5_8CursorTaskDefinition['action']; label: string }> = [
      { action: 'build', label: 'UE5_8 Cursor: Build' },
      { action: 'rebuild', label: 'UE5_8 Cursor: Rebuild' },
      { action: 'clean', label: 'UE5_8 Cursor: Clean' },
      { action: 'generateCompileCommands', label: 'UE5_8 Cursor: Refresh IntelliSense' },
    ];

    return defs.map(({ action, label }) => this.makeTask(folder, ctx, settings, action, label));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as UE5_8CursorTaskDefinition;
    if (def.type !== UE5_8CursorTaskProvider.type) return undefined;

    const ctx = this.getCtx();
    const settings = this.getSettings();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!ctx.project || !ctx.engine || !folder) return undefined;

    return this.makeTask(folder, ctx, settings, def.action, task.name);
  }

  private makeTask(
    folder: vscode.WorkspaceFolder,
    ctx: UE5_8CursorContext,
    settings: UE5_8CursorSettings,
    action: UE5_8CursorTaskDefinition['action'],
    label: string,
  ): vscode.Task {
    let cmdLine: { executable: string; args: string[] };

    if (action === 'generateCompileCommands') {
      cmdLine = generateClangDatabaseCommandLine(ctx.engine!, ctx.project!, {
        configuration: settings.buildConfiguration,
        platform: settings.platform,
      });
    } else if (action === 'clean') {
      cmdLine = cleanCommandLine(ctx.engine!, ctx.project!, {
        configuration: settings.buildConfiguration,
        targetType: settings.buildTarget,
        platform: settings.platform,
      });
    } else {
      cmdLine = buildCommandLine(ctx.engine!, ctx.project!, {
        configuration: settings.buildConfiguration,
        targetType: settings.buildTarget,
        platform: settings.platform,
      });
    }

    const definition: UE5_8CursorTaskDefinition = { type: UE5_8CursorTaskProvider.type, action };
    const task = new vscode.Task(
      definition,
      folder,
      label,
      EXTENSION_ID,
      new vscode.ShellExecution(cmdLine.executable, cmdLine.args),
      ['$msCompile', 'ue58rider-msvc'],
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
    return task;
  }
}

/** @deprecated */
export const UE58RiderTaskProvider = UE5_8CursorTaskProvider;
