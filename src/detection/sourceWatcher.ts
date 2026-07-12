import * as vscode from 'vscode';
import * as path from 'path';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorContext } from '../types';
import {
  classifySourceChange,
  invalidationLabel,
  shouldRefreshCompileDatabase,
  shouldRefreshReflectionOnly,
  type SourceChangeEvent,
} from './invalidation';
import { addTranslationUnitAction } from '../projectModel/projectModelService';

const DEBOUNCE_MS = 15_000;
const REFLECTION_DEBOUNCE_MS = 5_000;
const TU_DEBOUNCE_MS = 3_000;

interface PendingBatch {
  headers: Set<string>;
  translationUnits: Set<string>;
  modules: Set<string>;
  targetModules: Set<string>;
  projectModel: boolean;
  uhtModules: Set<string>;
  deletedPaths: Set<string>;
}

export function watchSourceChanges(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  onRefresh: () => void,
  onUhtHeaders?: (headers: string[]) => void,
  onProjectModelInvalidate?: () => void,
): vscode.Disposable {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return new vscode.Disposable(() => {});

  const pattern = new vscode.RelativePattern(folder, '**/{Source,Plugins}/**/*.{cpp,h,hpp,inl}');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const rspPattern = new vscode.RelativePattern(folder, '**/Intermediate/**/*.Shared.rsp');
  const rspWatcher = vscode.workspace.createFileSystemWatcher(rspPattern);
  const projectPattern = new vscode.RelativePattern(folder, '**/*.{uproject,uplugin,Build.cs,Target.cs}');
  const projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);

  const pending: PendingBatch = {
    headers: new Set(),
    translationUnits: new Set(),
    modules: new Set(),
    targetModules: new Set(),
    projectModel: false,
    uhtModules: new Set(),
    deletedPaths: new Set(),
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let rspDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reflectionTimer: ReturnType<typeof setTimeout> | undefined;
  let tuTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPending = (): void => {
    pending.headers.clear();
    pending.translationUnits.clear();
    pending.modules.clear();
    pending.targetModules.clear();
    pending.projectModel = false;
    pending.uhtModules.clear();
    pending.deletedPaths.clear();
  };

  const enqueueEvent = (event: SourceChangeEvent, isDelete: boolean): void => {
    if (isDelete) {
      pending.deletedPaths.add(event.filePath);
      if (event.scope === 'projectModel') pending.projectModel = true;
      if (event.moduleName) pending.modules.add(event.moduleName);
      return;
    }

    switch (event.scope) {
      case 'reflection':
        pending.headers.add(event.filePath);
        break;
      case 'uhtModule':
        pending.uhtModules.add(event.filePath);
        if (event.moduleName) pending.modules.add(event.moduleName);
        break;
      case 'translationUnit':
        pending.translationUnits.add(event.filePath);
        break;
      case 'module':
        if (event.moduleName) pending.modules.add(event.moduleName);
        break;
      case 'projectModel':
        pending.projectModel = true;
        break;
      case 'targetModule':
        pending.targetModules.add(event.filePath);
        break;
      default:
        break;
    }
  };

  const flushReflectionBatch = (): void => {
    if (!ctx.project || pending.headers.size === 0) return;
    const headers = [...pending.headers];
    pending.headers.clear();
    for (const headerPath of headers) {
      void import('../uht/reflectionIndex').then(({ refreshReflectionForHeader }) =>
        refreshReflectionForHeader(ctx.project!.projectRoot, headerPath),
      );
    }
  };

  const flushTuBatch = async (): Promise<void> => {
    if (!ctx.project || pending.translationUnits.size === 0) return;
    const tus = [...pending.translationUnits];
    pending.translationUnits.clear();

    if (!settings.experimentalIncrementalCompileDb) {
      ctx.outputChannel.appendLine(
        `[UE5_8 Cursor] ${tus.length} new translation unit(s) — scheduling full compile_commands refresh`,
      );
      onRefresh();
      return;
    }

    let anyAdded = false;
    for (const tuPath of tus) {
      const added = await addTranslationUnitAction(ctx.project.projectRoot, tuPath);
      if (added) {
        anyAdded = true;
        ctx.outputChannel.appendLine(`[UE5_8 Cursor] Added provisional compile action for ${path.basename(tuPath)}`);
      }
    }
    if (anyAdded) {
      try {
        await vscode.commands.executeCommand('clangd.restart');
      } catch {
        // clangd may not be active
      }
    } else {
      onRefresh();
    }
  };

  const flushCompileRefreshBatch = (): void => {
    if (!ctx.project) return;
    const scopes: string[] = [];
    const uhtHeaders = [...pending.uhtModules];
    if (pending.projectModel) scopes.push('project model');
    if (pending.modules.size > 0) scopes.push(`${pending.modules.size} module(s)`);
    if (pending.uhtModules.size > 0) scopes.push(`${pending.uhtModules.size} UHT header(s)`);
    if (pending.targetModules.size > 0) scopes.push(`${pending.targetModules.size} RSP(s)`);
    if (pending.deletedPaths.size > 0) scopes.push(`${pending.deletedPaths.size} delete(s)`);
    if (scopes.length === 0) return;

    if (pending.projectModel && onProjectModelInvalidate) {
      onProjectModelInvalidate();
    }
    if (uhtHeaders.length > 0 && onUhtHeaders) {
      onUhtHeaders(uhtHeaders);
    }

    ctx.outputChannel.appendLine(
      `[UE5_8 Cursor] Batch invalidation (${scopes.join(', ')}) — refreshing IntelliSense...`,
    );
    clearPending();
    onRefresh();
  };

  const schedule = (uri: vscode.Uri, isCreate: boolean, isDelete = false) => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;

    const event = classifySourceChange(uri.fsPath, isCreate, ctx.project.projectRoot);
    enqueueEvent(event, isDelete);

    if (event.scope === 'reflection' && !isDelete) {
      if (reflectionTimer) clearTimeout(reflectionTimer);
      reflectionTimer = setTimeout(flushReflectionBatch, REFLECTION_DEBOUNCE_MS);
      if (shouldRefreshReflectionOnly(event)) return;
    }

    if (isCreate && event.scope === 'translationUnit') {
      if (tuTimer) clearTimeout(tuTimer);
      tuTimer = setTimeout(() => {
        void flushTuBatch();
      }, TU_DEBOUNCE_MS);
      return;
    }

    if (!shouldRefreshCompileDatabase(event) && !isDelete) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushCompileRefreshBatch, DEBOUNCE_MS);
  };

  const scheduleRspBootstrap = (uri: vscode.Uri) => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;
    pending.targetModules.add(uri.fsPath);
    if (rspDebounceTimer) clearTimeout(rspDebounceTimer);
    rspDebounceTimer = setTimeout(() => {
      ctx.outputChannel.appendLine(
        `[UE5_8 Cursor] ${invalidationLabel('targetModule')} change — refreshing compile_commands...`,
      );
      pending.targetModules.clear();
      onRefresh();
    }, 5000);
  };

  return vscode.Disposable.from(
    watcher.onDidCreate((uri) => schedule(uri, true)),
    watcher.onDidChange((uri) => schedule(uri, false)),
    watcher.onDidDelete((uri) => schedule(uri, false, true)),
    rspWatcher.onDidCreate(scheduleRspBootstrap),
    rspWatcher.onDidChange(scheduleRspBootstrap),
    projectWatcher.onDidCreate((uri) => schedule(uri, true)),
    projectWatcher.onDidChange((uri) => schedule(uri, false)),
    projectWatcher.onDidDelete((uri) => schedule(uri, false, true)),
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
