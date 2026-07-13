import * as vscode from 'vscode';
import * as path from 'path';
import { EXTENSION_ID } from '../constants';
import { buildCommandLine, cleanCommandLine, generateClangDatabaseCommandLine } from '../build/ubt';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorTaskDefinition } from '../types';
import { getWorkspaceProjectRegistry } from '../session/workspaceProjectRegistry';

function workspaceFolderForProject(project: { projectRoot: string }): vscode.WorkspaceFolder | undefined {
  const root = path.resolve(project.projectRoot);
  return vscode.workspace.workspaceFolders?.find((folder) => {
    const folderRoot = path.resolve(folder.uri.fsPath);
    const rootLower = root.toLowerCase();
    const folderLower = folderRoot.toLowerCase();
    return rootLower === folderLower || rootLower.startsWith(`${folderLower}${path.sep}`);
  });
}

function quoteShellArg(arg: string): string {
  return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

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

    const folder = workspaceFolderForProject(ctx.project);
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

    const ctx = this.resolveContext(def);
    const settings = this.getSettings();
    const folder = ctx?.project ? workspaceFolderForProject(ctx.project) : undefined;
    if (!ctx?.project || !ctx.engine || !folder) return undefined;

    return this.makeTask(folder, ctx, settings, def.action, task.name, def);
  }

  private resolveContext(def?: UE5_8CursorTaskDefinition): UE5_8CursorContext | undefined {
    const base = this.getCtx();
    if (!def?.projectRoot) return base.project && base.engine ? base : undefined;

    const runtime = getWorkspaceProjectRegistry().getByRoot(def.projectRoot);
    if (runtime) {
      return { ...base, project: runtime.project, engine: runtime.engine ?? base.engine };
    }

    const wanted = path.resolve(def.projectRoot).toLowerCase();
    if (base.project && path.resolve(base.project.projectRoot).toLowerCase() === wanted) {
      return base;
    }
    return undefined;
  }

  private buildOptions(
    settings: UE5_8CursorSettings,
    seed?: UE5_8CursorTaskDefinition,
  ): { configuration: UE5_8CursorSettings['buildConfiguration']; targetType: UE5_8CursorSettings['buildTarget']; platform: UE5_8CursorSettings['platform'] } {
    return {
      configuration: (seed?.buildConfiguration as UE5_8CursorSettings['buildConfiguration']) ?? settings.buildConfiguration,
      targetType: (seed?.buildTarget as UE5_8CursorSettings['buildTarget']) ?? settings.buildTarget,
      platform: (seed?.platform as UE5_8CursorSettings['platform']) ?? settings.platform,
    };
  }

  private makeTask(
    folder: vscode.WorkspaceFolder,
    ctx: UE5_8CursorContext,
    settings: UE5_8CursorSettings,
    action: UE5_8CursorTaskDefinition['action'],
    label: string,
    seed?: UE5_8CursorTaskDefinition,
  ): vscode.Task {
    const buildOpts = this.buildOptions(settings, seed);

    let execution: vscode.ShellExecution;
    if (action === 'generateCompileCommands') {
      const cmdLine = generateClangDatabaseCommandLine(ctx.engine!, ctx.project!, {
        configuration: settings.buildConfiguration,
        platform: settings.platform,
      });
      execution = new vscode.ShellExecution(cmdLine.executable, cmdLine.args);
    } else if (action === 'clean') {
      const cmdLine = cleanCommandLine(ctx.engine!, ctx.project!, buildOpts);
      execution = new vscode.ShellExecution(cmdLine.executable, cmdLine.args);
    } else if (action === 'rebuild') {
      const clean = cleanCommandLine(ctx.engine!, ctx.project!, buildOpts);
      const build = buildCommandLine(ctx.engine!, ctx.project!, buildOpts);
      const shellLine = [
        quoteShellArg(clean.executable),
        ...clean.args.map(quoteShellArg),
        '&&',
        quoteShellArg(build.executable),
        ...build.args.map(quoteShellArg),
      ].join(' ');
      execution = new vscode.ShellExecution(shellLine);
    } else {
      const cmdLine = buildCommandLine(ctx.engine!, ctx.project!, buildOpts);
      execution = new vscode.ShellExecution(cmdLine.executable, cmdLine.args);
    }

    const definition: UE5_8CursorTaskDefinition = {
      type: UE5_8CursorTaskProvider.type,
      action,
      projectRoot: seed?.projectRoot ?? ctx.project!.projectRoot,
      engineRoot: seed?.engineRoot ?? ctx.engine!.root,
      buildTarget: seed?.buildTarget ?? settings.buildTarget,
      buildConfiguration: seed?.buildConfiguration ?? settings.buildConfiguration,
      platform: seed?.platform ?? settings.platform,
    };
    const task = new vscode.Task(definition, folder, label, EXTENSION_ID, execution, [
      '$msCompile',
      'ue58rider-msvc',
    ]);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
    return task;
  }
}

/** @deprecated */
export const UE58RiderTaskProvider = UE5_8CursorTaskProvider;
