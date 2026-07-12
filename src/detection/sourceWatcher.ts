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

export interface SourceWatcherRuntime {
  ctx: UE5_8CursorContext;
  key: string;
}

interface PendingBatch {
  headers: Set<string>;
  translationUnits: Set<string>;
  modules: Set<string>;
  targetModules: Set<string>;
  projectModel: boolean;
  uhtModules: Set<string>;
  deletedPaths: Set<string>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  rspDebounceTimer?: ReturnType<typeof setTimeout>;
  reflectionTimer?: ReturnType<typeof setTimeout>;
  tuTimer?: ReturnType<typeof setTimeout>;
}

function createPending(): PendingBatch {
  return {
    headers: new Set(), translationUnits: new Set(), modules: new Set(), targetModules: new Set(),
    projectModel: false, uhtModules: new Set(), deletedPaths: new Set(),
  };
}

function clearPending(pending: PendingBatch): void {
  pending.headers.clear();
  pending.translationUnits.clear();
  pending.modules.clear();
  pending.targetModules.clear();
  pending.projectModel = false;
  pending.uhtModules.clear();
  pending.deletedPaths.clear();
}

/**
 * Watches every workspace folder but batches each event by the runtime that owns
 * its URI. This prevents a secondary project's source edit from refreshing the
 * primary project's compile database or UHT cache.
 */
export function watchSourceChanges(
  settings: UE5_8CursorSettings,
  resolveRuntime: (uri: vscode.Uri) => SourceWatcherRuntime | undefined,
  onRefresh: (runtime: SourceWatcherRuntime) => void,
  onUhtHeaders?: (runtime: SourceWatcherRuntime, headers: string[]) => void,
  onProjectModelInvalidate?: (runtime: SourceWatcherRuntime) => void,
): vscode.Disposable {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return new vscode.Disposable(() => {});

  const states = new Map<string, PendingBatch>();
  const stateFor = (runtime: SourceWatcherRuntime): PendingBatch => {
    let state = states.get(runtime.key);
    if (!state) {
      state = createPending();
      states.set(runtime.key, state);
    }
    return state;
  };

  const enqueueEvent = (pending: PendingBatch, event: SourceChangeEvent, isDelete: boolean): void => {
    if (isDelete) {
      pending.deletedPaths.add(event.filePath);
      if (event.scope === 'projectModel') pending.projectModel = true;
      if (event.moduleName) pending.modules.add(event.moduleName);
      return;
    }
    switch (event.scope) {
      case 'reflection': pending.headers.add(event.filePath); break;
      case 'uhtModule':
        pending.uhtModules.add(event.filePath);
        if (event.moduleName) pending.modules.add(event.moduleName);
        break;
      case 'translationUnit': pending.translationUnits.add(event.filePath); break;
      case 'module': if (event.moduleName) pending.modules.add(event.moduleName); break;
      case 'projectModel': pending.projectModel = true; break;
      case 'targetModule': pending.targetModules.add(event.filePath); break;
    }
  };

  const flushReflectionBatch = (runtime: SourceWatcherRuntime, pending: PendingBatch): void => {
    if (!runtime.ctx.project || pending.headers.size === 0) return;
    const headers = [...pending.headers];
    pending.headers.clear();
    for (const headerPath of headers) {
      void import('../uht/reflectionIndex').then(({ refreshReflectionForHeader }) =>
        refreshReflectionForHeader(runtime.ctx.project!.projectRoot, headerPath),
      );
    }
  };

  const flushTuBatch = async (runtime: SourceWatcherRuntime, pending: PendingBatch): Promise<void> => {
    if (!runtime.ctx.project || pending.translationUnits.size === 0) return;
    const tus = [...pending.translationUnits];
    pending.translationUnits.clear();
    if (!settings.experimentalIncrementalCompileDb) {
      runtime.ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${tus.length} new translation unit(s); scheduling compile_commands refresh.`);
      onRefresh(runtime);
      return;
    }
    let anyAdded = false;
    for (const tuPath of tus) {
      const added = await addTranslationUnitAction(runtime.ctx.project.projectRoot, tuPath);
      if (added) {
        anyAdded = true;
        runtime.ctx.outputChannel.appendLine(`[UE5_8 Cursor] Added provisional compile action for ${path.basename(tuPath)}`);
      }
    }
    if (anyAdded) {
      try { await vscode.commands.executeCommand('clangd.restart'); } catch { /* clangd may be inactive */ }
    } else {
      onRefresh(runtime);
    }
  };

  const flushCompileRefreshBatch = (runtime: SourceWatcherRuntime, pending: PendingBatch): void => {
    if (!runtime.ctx.project) return;
    const scopes: string[] = [];
    const uhtHeaders = [...pending.uhtModules];
    if (pending.projectModel) scopes.push('project model');
    if (pending.modules.size) scopes.push(`${pending.modules.size} module(s)`);
    if (pending.uhtModules.size) scopes.push(`${pending.uhtModules.size} UHT header(s)`);
    if (pending.targetModules.size) scopes.push(`${pending.targetModules.size} RSP(s)`);
    if (pending.deletedPaths.size) scopes.push(`${pending.deletedPaths.size} delete(s)`);
    if (scopes.length === 0) return;
    if (pending.projectModel) onProjectModelInvalidate?.(runtime);
    if (uhtHeaders.length) onUhtHeaders?.(runtime, uhtHeaders);
    runtime.ctx.outputChannel.appendLine(`[UE5_8 Cursor] Batch invalidation (${scopes.join(', ')}); refreshing IntelliSense...`);
    clearPending(pending);
    onRefresh(runtime);
  };

  const schedule = (uri: vscode.Uri, isCreate: boolean, isDelete = false): void => {
    if (!settings.autoRefreshOnSourceChange) return;
    const runtime = resolveRuntime(uri);
    if (!runtime?.ctx.project) return;
    const pending = stateFor(runtime);
    const event = classifySourceChange(uri.fsPath, isCreate, runtime.ctx.project.projectRoot);
    enqueueEvent(pending, event, isDelete);
    if (event.scope === 'reflection' && !isDelete) {
      if (pending.reflectionTimer) clearTimeout(pending.reflectionTimer);
      pending.reflectionTimer = setTimeout(() => flushReflectionBatch(runtime, pending), REFLECTION_DEBOUNCE_MS);
      if (shouldRefreshReflectionOnly(event)) return;
    }
    if (isCreate && event.scope === 'translationUnit') {
      if (pending.tuTimer) clearTimeout(pending.tuTimer);
      pending.tuTimer = setTimeout(() => { void flushTuBatch(runtime, pending); }, TU_DEBOUNCE_MS);
      return;
    }
    if (!shouldRefreshCompileDatabase(event) && !isDelete) return;
    if (pending.debounceTimer) clearTimeout(pending.debounceTimer);
    pending.debounceTimer = setTimeout(() => flushCompileRefreshBatch(runtime, pending), DEBOUNCE_MS);
  };

  const scheduleRspBootstrap = (uri: vscode.Uri): void => {
    if (!settings.autoRefreshOnSourceChange) return;
    const runtime = resolveRuntime(uri);
    if (!runtime?.ctx.project) return;
    const pending = stateFor(runtime);
    pending.targetModules.add(uri.fsPath);
    if (pending.rspDebounceTimer) clearTimeout(pending.rspDebounceTimer);
    pending.rspDebounceTimer = setTimeout(() => {
      runtime.ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${invalidationLabel('targetModule')} change; refreshing compile_commands...`);
      pending.targetModules.clear();
      onRefresh(runtime);
    }, 5_000);
  };

  const disposables: vscode.Disposable[] = [];
  for (const folder of folders) {
    const source = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/{Source,Plugins}/**/*.{cpp,h,hpp,inl}'));
    const rsp = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/Intermediate/**/*.Shared.rsp'));
    const project = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{uproject,uplugin,Build.cs,Target.cs}'));
    disposables.push(
      source.onDidCreate((uri) => schedule(uri, true)), source.onDidChange((uri) => schedule(uri, false)), source.onDidDelete((uri) => schedule(uri, false, true)),
      rsp.onDidCreate(scheduleRspBootstrap), rsp.onDidChange(scheduleRspBootstrap),
      project.onDidCreate((uri) => schedule(uri, true)), project.onDidChange((uri) => schedule(uri, false)), project.onDidDelete((uri) => schedule(uri, false, true)),
      source, rsp, project,
    );
  }
  return vscode.Disposable.from(...disposables, {
    dispose: () => {
      for (const pending of states.values()) {
        if (pending.debounceTimer) clearTimeout(pending.debounceTimer);
        if (pending.rspDebounceTimer) clearTimeout(pending.rspDebounceTimer);
        if (pending.reflectionTimer) clearTimeout(pending.reflectionTimer);
        if (pending.tuTimer) clearTimeout(pending.tuTimer);
      }
      states.clear();
    },
  });
}
