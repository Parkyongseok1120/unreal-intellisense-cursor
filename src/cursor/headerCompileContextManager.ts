import * as path from 'path';
import * as vscode from 'vscode';
import type { HeaderCompileContext } from '../projectModel/headerCompileContext';
import { buildHeaderContextFingerprint } from './headerCompileContextFingerprint';
import { clearAuthoritativeHeaderCompileContexts } from './clangdHeaderContext';

const headerCompileContextLog = new Map<string, string>();
const provisionalHeaderPaths = new Set<string>();
const MAX_HEADER_CONTEXT_LOG = 512;

export { buildHeaderContextFingerprint } from './headerCompileContextFingerprint';

export function invalidateHeaderCompileContextLog(headerPath?: string, projectRoot?: string): void {
  if (headerPath) {
    headerCompileContextLog.delete(headerPath.toLowerCase());
    return;
  }
  if (!projectRoot) {
    headerCompileContextLog.clear();
    return;
  }
  const prefix = `${path.resolve(projectRoot).toLowerCase()}${path.sep}`;
  for (const key of [...headerCompileContextLog.keys()]) {
    if (key.startsWith(prefix)) headerCompileContextLog.delete(key);
  }
}

export function clearHeaderCompileContextState(projectRoot?: string): void {
  clearAuthoritativeHeaderCompileContexts(projectRoot);
  invalidateHeaderCompileContextLog(undefined, projectRoot);
  clearProvisionalHeaderPaths(projectRoot);
}

export function countProvisionalHeaders(projectRoot: string): number {
  const prefix = `${path.resolve(projectRoot).toLowerCase()}${path.sep}`;
  let count = 0;
  for (const headerPath of provisionalHeaderPaths) {
    if (headerPath.startsWith(prefix)) count++;
  }
  return count;
}

function markProvisionalHeader(headerPath: string, provisional: boolean): void {
  const key = headerPath.toLowerCase();
  if (provisional) provisionalHeaderPaths.add(key);
  else provisionalHeaderPaths.delete(key);
}

function clearProvisionalHeaderPaths(projectRoot?: string): void {
  if (!projectRoot) {
    provisionalHeaderPaths.clear();
    return;
  }
  const prefix = `${path.resolve(projectRoot).toLowerCase()}${path.sep}`;
  for (const key of [...provisionalHeaderPaths]) {
    if (key.startsWith(prefix)) provisionalHeaderPaths.delete(key);
  }
}

export async function reportHeaderCompileContext(
  document: vscode.TextDocument,
  projectRoot: string,
  log: (message: string) => void,
  force = false,
): Promise<void> {
  if (document.uri.scheme !== 'file' || !/\.(?:h|hpp|inl)$/i.test(document.uri.fsPath)) return;
  const { resolveHeaderCompileContext } = await import('../projectModel/headerCompileContext');
  const resolved = await resolveHeaderCompileContext(projectRoot, document.uri.fsPath);
  const key = document.uri.fsPath.toLowerCase();
  const fingerprint = buildHeaderContextFingerprint(resolved);
  if (!force && headerCompileContextLog.get(key) === fingerprint) return;

  if (resolved.provenance === 'authoritative-module-tu') {
    const { applyAuthoritativeHeaderCompileContext } = await import('./clangdHeaderContext');
    const applied = await applyAuthoritativeHeaderCompileContext(projectRoot, resolved);
    if (applied.applied) {
      headerCompileContextLog.set(key, fingerprint);
      trimHeaderContextLog();
      markProvisionalHeader(document.uri.fsPath, false);
      log(`[UE5_8 Cursor] Header compile context applied: ${document.uri.fsPath} <- ${resolved.translationUnit}`);
    } else {
      headerCompileContextLog.delete(key);
      markProvisionalHeader(document.uri.fsPath, true);
      log(`[UE5_8 Cursor] Header compile context provisional: ${document.uri.fsPath}. ${applied.reason}`);
    }
  } else {
    headerCompileContextLog.set(key, fingerprint);
    trimHeaderContextLog();
    markProvisionalHeader(document.uri.fsPath, true);
    log(`[UE5_8 Cursor] Header compile context provisional: ${document.uri.fsPath}. ${resolved.reason}`);
  }
}

export async function reapplyOpenHeaderContexts(
  projectRoot: string,
  log: (message: string) => void,
): Promise<void> {
  invalidateHeaderCompileContextLog(undefined, projectRoot);
  const prefix = `${path.resolve(projectRoot).toLowerCase()}${path.sep}`;
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file' || !/\.(?:h|hpp|inl)$/i.test(document.uri.fsPath)) continue;
    if (!document.uri.fsPath.toLowerCase().startsWith(prefix)) continue;
    await reportHeaderCompileContext(document, projectRoot, log, true);
  }
}

function trimHeaderContextLog(): void {
  if (headerCompileContextLog.size <= MAX_HEADER_CONTEXT_LOG) return;
  const excess = headerCompileContextLog.size - MAX_HEADER_CONTEXT_LOG;
  const keys = [...headerCompileContextLog.keys()];
  for (let i = 0; i < excess; i++) headerCompileContextLog.delete(keys[i]);
}
