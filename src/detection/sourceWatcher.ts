import * as vscode from 'vscode';
import * as path from 'path';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorContext } from '../types';
import {
  classifySourceChange,
  invalidationLabel,
  shouldRefreshCompileDatabase,
  shouldRefreshReflectionOnly,
} from './invalidation';
import { addTranslationUnitAction } from '../projectModel/projectModelService';

const DEBOUNCE_MS = 15_000;
const REFLECTION_DEBOUNCE_MS = 5_000;
const TU_DEBOUNCE_MS = 3_000;

export function watchSourceChanges(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  onRefresh: () => void,
): vscode.Disposable {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return new vscode.Disposable(() => {});

  const pattern = new vscode.RelativePattern(folder, '**/{Source,Plugins}/**/*.{cpp,h,hpp,inl}');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const rspPattern = new vscode.RelativePattern(folder, '**/Intermediate/**/*.Shared.rsp');
  const rspWatcher = vscode.workspace.createFileSystemWatcher(rspPattern);
  const projectPattern = new vscode.RelativePattern(folder, '**/*.{uproject,uplugin,Build.cs,Target.cs}');
  const projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let rspDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reflectionTimer: ReturnType<typeof setTimeout> | undefined;
  let tuTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRspBootstrap = (uri: vscode.Uri) => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;
    if (rspDebounceTimer) clearTimeout(rspDebounceTimer);
    rspDebounceTimer = setTimeout(() => {
      const event = classifySourceChange(uri.fsPath, false, ctx.project!.projectRoot);
      ctx.outputChannel.appendLine(
        `[UE5_8 Cursor] ${invalidationLabel(event.scope)} change — refreshing compile_commands...`,
      );
      onRefresh();
    }, 5000);
  };

  const scheduleReflection = (uri: vscode.Uri) => {
    if (!ctx.project || !uri.fsPath.endsWith('.h')) return;
    if (reflectionTimer) clearTimeout(reflectionTimer);
    reflectionTimer = setTimeout(() => {
      void import('../uht/reflectionIndex').then(({ refreshReflectionForHeader }) =>
        refreshReflectionForHeader(ctx.project!.projectRoot, uri.fsPath),
      );
    }, REFLECTION_DEBOUNCE_MS);
  };

  const scheduleIncrementalTu = async (uri: vscode.Uri) => {
    if (!ctx.project || !uri.fsPath.endsWith('.cpp')) return;
    if (tuTimer) clearTimeout(tuTimer);
    tuTimer = setTimeout(async () => {
      const added = await addTranslationUnitAction(ctx.project!.projectRoot, uri.fsPath);
      if (added) {
        ctx.outputChannel.appendLine(`[UE5_8 Cursor] Added compile action for ${path.basename(uri.fsPath)}`);
        try {
          await vscode.commands.executeCommand('clangd.restart');
        } catch {
          // clangd may not be active
        }
      } else {
        onRefresh();
      }
    }, TU_DEBOUNCE_MS);
  };

  const schedule = (uri: vscode.Uri, isCreate: boolean) => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;

    const event = classifySourceChange(uri.fsPath, isCreate, ctx.project.projectRoot);

    if (event.scope === 'reflection') {
      scheduleReflection(uri);
      if (shouldRefreshReflectionOnly(event)) return;
    }

    if (isCreate && event.scope === 'translationUnit') {
      void scheduleIncrementalTu(uri);
      return;
    }

    if (!shouldRefreshCompileDatabase(event)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      ctx.outputChannel.appendLine(
        `[UE5_8 Cursor] ${invalidationLabel(event.scope)} change — refreshing IntelliSense...`,
      );
      onRefresh();
    }, DEBOUNCE_MS);
  };

  return vscode.Disposable.from(
    watcher.onDidCreate((uri) => schedule(uri, true)),
    watcher.onDidChange((uri) => schedule(uri, false)),
    watcher.onDidDelete((uri) => schedule(uri, false)),
    rspWatcher.onDidCreate(scheduleRspBootstrap),
    rspWatcher.onDidChange(scheduleRspBootstrap),
    projectWatcher.onDidCreate((uri) => schedule(uri, true)),
    projectWatcher.onDidChange((uri) => schedule(uri, false)),
    projectWatcher.onDidDelete((uri) => schedule(uri, false)),
    rspWatcher,
    projectWatcher,
    watcher,
    {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (rspDebounceTimer) clearTimeout(rspDebounceTimer);
        if (reflectionTimer) clearTimeout(reflectionTimer);
        if (tuTimer) clearTimeout(tuTimer);
      },
    },
  );
}
