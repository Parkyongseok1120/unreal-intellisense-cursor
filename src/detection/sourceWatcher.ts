import * as vscode from 'vscode';
import * as path from 'path';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UE5_8CursorContext } from '../types';

const DEBOUNCE_MS = 15_000;
const REFLECTION_DEBOUNCE_MS = 5_000;
const trackedModules = new Set<string>();

function moduleFromPath(filePath: string, projectRoot: string): string | undefined {
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const sourceMatch = rel.match(/^Source\/([^/]+)\//);
  if (sourceMatch) return sourceMatch[1];
  const pluginMatch = rel.match(/^Plugins\/[^/]+\/Source\/([^/]+)\//);
  if (pluginMatch) return pluginMatch[1];
  return undefined;
}

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
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let rspDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reflectionTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRspBootstrap = () => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;
    if (rspDebounceTimer) clearTimeout(rspDebounceTimer);
    rspDebounceTimer = setTimeout(() => {
      ctx.outputChannel.appendLine('[UE5_8 Cursor] .Shared.rsp detected — refreshing compile_commands...');
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

  const schedule = (uri: vscode.Uri, isCreate: boolean) => {
    if (!settings.autoRefreshOnSourceChange || !ctx.project) return;

    scheduleReflection(uri);

    if (isCreate && ctx.project) {
      const mod = moduleFromPath(uri.fsPath, ctx.project.projectRoot);
      if (mod && trackedModules.has(mod)) {
        return;
      }
      if (mod) trackedModules.add(mod);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      ctx.outputChannel.appendLine('[UE5_8 Cursor] Source change detected — refreshing IntelliSense...');
      onRefresh();
    }, DEBOUNCE_MS);
  };

  if (ctx.project) {
    trackedModules.clear();
    for (const mod of ctx.project.modules) {
      trackedModules.add(mod.name);
    }
  }

  return vscode.Disposable.from(
    watcher.onDidCreate((uri) => schedule(uri, true)),
    watcher.onDidChange((uri) => schedule(uri, false)),
    watcher.onDidDelete((uri) => schedule(uri, false)),
    rspWatcher.onDidCreate(scheduleRspBootstrap),
    rspWatcher.onDidChange(scheduleRspBootstrap),
    rspWatcher,
    watcher,
    {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (rspDebounceTimer) clearTimeout(rspDebounceTimer);
        if (reflectionTimer) clearTimeout(reflectionTimer);
      },
    },
  );
}
