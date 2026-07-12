import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { ProjectSession } from '../session/projectSession';
import type { UE5_8CursorSettings } from '../config/settings';
import { runUhtOnHeader } from './uhtRunner';
import { publishUhtDiagnostics, clearUhtDiagnostics } from './uhtDiagnostics';
import { inspectionsToDiagnostics, runUeInspections } from './ueInspections';

const pendingHeaders = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let activeHeader: string | undefined;
let activeGeneration = -1;
const resultCache = new Map<string, { fingerprint: string; at: number }>();

export function scheduleUhtValidation(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  headerPath: string,
  settings?: UE5_8CursorSettings,
): void {
  if (!ctx.project || !ctx.engine) return;
  if (!headerPath.endsWith('.h')) return;

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath !== headerPath) {
    return;
  }

  pendingHeaders.add(headerPath);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flushUhtValidation(ctx, projectSession, settings);
  }, 2000);
}

export async function validateHeaderNow(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  headerPath: string,
  settings?: UE5_8CursorSettings,
  token?: vscode.CancellationToken,
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath !== headerPath) {
    return;
  }

  const gen = projectSession.getGeneration();
  const activeToken = token ?? projectSession.getActiveToken();
  if (!activeToken) return;

  if (activeHeader && activeHeader !== headerPath && activeGeneration !== gen) {
    clearUhtDiagnostics(vscode.Uri.file(activeHeader));
  }
  activeHeader = headerPath;
  activeGeneration = gen;

  await projectSession.runJob('reflection', ctx.project.projectRoot, gen, activeToken, async () => {
    if (projectSession.isStale(gen) || activeToken.isCancellationRequested) return;

    let content = '';
    try {
      content = await vscode.workspace.fs.readFile(vscode.Uri.file(headerPath)).then((b) => Buffer.from(b).toString('utf-8'));
    } catch {
      return;
    }

    const inspectionsOn = settings?.uhtInspectionsEnabled ?? false;
    const inspectionResult = runUeInspections(content, inspectionsOn);
    const cacheKey = headerPath.toLowerCase();
    const cached = resultCache.get(cacheKey);
    if (cached?.fingerprint === inspectionResult.fingerprint && Date.now() - cached.at < 30_000 && inspectionsOn) {
      publishUhtDiagnostics(ctx, vscode.Uri.file(headerPath), inspectionsToDiagnostics(vscode.Uri.file(headerPath), inspectionResult));
      return;
    }

    const result = await runUhtOnHeader(ctx.project!, ctx.engine!, headerPath, activeToken);
    if (projectSession.isStale(gen) || activeToken.isCancellationRequested) return;

    resultCache.set(cacheKey, { fingerprint: inspectionResult.fingerprint, at: Date.now() });

    const uri = vscode.Uri.file(headerPath);
    const inspectionDiags = inspectionsOn ? inspectionsToDiagnostics(uri, inspectionResult) : [];
    const all = [...inspectionDiags, ...result.diagnostics];
    if (all.length > 0) {
      publishUhtDiagnostics(ctx, uri, all);
    } else if (!result.ok) {
      if (result.stderr.includes('manifest missing')) {
        clearUhtDiagnostics(uri);
      } else {
        const errDiag = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `UHT validation failed: ${result.stderr.slice(0, 200)}`,
          vscode.DiagnosticSeverity.Warning,
        );
        errDiag.source = 'UHT';
        publishUhtDiagnostics(ctx, uri, [errDiag]);
      }
    } else {
      clearUhtDiagnostics(uri);
    }
  });
}

async function flushUhtValidation(ctx: UE5_8CursorContext, projectSession: ProjectSession, settings?: UE5_8CursorSettings): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const active = editor?.document.uri.fsPath;
  const headers = [...pendingHeaders].filter((h) => !active || h === active);
  pendingHeaders.clear();
  for (const header of headers) {
    await validateHeaderNow(ctx, projectSession, header, settings);
  }
}

export function registerUhtSaveValidation(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  settings: UE5_8CursorSettings,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'cpp' || !doc.fileName.endsWith('.h')) return;
      scheduleUhtValidation(ctx, projectSession, doc.uri.fsPath);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor?.document.fileName.endsWith('.h')) return;
      scheduleUhtValidation(ctx, projectSession, editor.document.uri.fsPath);
    }),
  );
}

export function clearUhtValidationCache(): void {
  resultCache.clear();
  pendingHeaders.clear();
  activeHeader = undefined;
}
