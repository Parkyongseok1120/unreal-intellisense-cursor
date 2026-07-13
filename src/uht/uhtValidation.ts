import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { ProjectSession } from '../session/projectSession';
import type { UE5_8CursorSettings } from '../config/settings';
import { runUhtOnHeader, parseUhtManifestInputFiles, type UhtDiagnostic } from './uhtRunner';
import { publishUhtDiagnostics, clearUhtDiagnostics } from './uhtDiagnostics';
import { inspectionsToDiagnostics, runUeInspections } from './ueInspections';

interface ValidationState {
  pendingHeaders: Set<string>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  activeHeader?: string;
  activeGeneration: number;
  inspectionCache: Map<string, CachedInspection>;
  uhtCache: Map<string, CachedUht>;
}

interface CachedInspection {
  fingerprint: string;
  at: number;
  diagnostics: vscode.Diagnostic[];
}

interface CachedUht {
  cacheKey: string;
  at: number;
  byFile: Map<string, UhtDiagnostic[]>;
}

const validationStates = new Map<string, ValidationState>();

function stateFor(ctx: UE5_8CursorContext): ValidationState | undefined {
  if (!ctx.project) return undefined;
  const key = ctx.project.projectRoot.toLowerCase();
  let state = validationStates.get(key);
  if (!state) {
    state = {
      pendingHeaders: new Set(),
      activeGeneration: -1,
      inspectionCache: new Map(),
      uhtCache: new Map(),
    };
    validationStates.set(key, state);
  }
  return state;
}

export interface UhtValidationRuntime {
  ctx: UE5_8CursorContext;
  session: ProjectSession;
}

export function scheduleUhtValidation(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  headerPath: string,
  settings?: UE5_8CursorSettings,
): void {
  if (!ctx.project || !ctx.engine) return;
  if (!headerPath.endsWith('.h')) return;
  const state = stateFor(ctx);
  if (!state) return;

  state.pendingHeaders.add(headerPath);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    void flushUhtValidation(ctx, projectSession, settings, state);
  }, 2000);
}

function groupDiagnosticsByFile(diagnostics: UhtDiagnostic[]): Map<string, UhtDiagnostic[]> {
  const grouped = new Map<string, UhtDiagnostic[]>();
  for (const diag of diagnostics) {
    const key = diag.file.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(diag);
    grouped.set(key, list);
  }
  return grouped;
}

async function publishUhtForManifestFiles(
  ctx: UE5_8CursorContext,
  manifestPath: string | undefined,
  byFile: Map<string, UhtDiagnostic[]>,
): Promise<void> {
  if (!manifestPath) return;
  const inputFiles = await parseUhtManifestInputFiles(manifestPath);
  for (const filePath of inputFiles) {
    if (!filePath.endsWith('.h')) continue;
    const uri = vscode.Uri.file(filePath);
    const diags = byFile.get(filePath.toLowerCase()) ?? [];
    if (diags.length > 0) publishUhtDiagnostics(ctx, uri, diags);
    else clearUhtDiagnostics(uri);
  }
}

export async function validateHeaderNow(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  headerPath: string,
  settings?: UE5_8CursorSettings,
  token?: vscode.CancellationToken,
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;
  const state = stateFor(ctx);
  if (!state) return;

  const gen = projectSession.getGeneration();
  const activeToken = token ?? projectSession.getActiveToken();
  if (!activeToken) return;

  if (state.activeHeader && state.activeHeader !== headerPath && state.activeGeneration !== gen) {
    clearUhtDiagnostics(vscode.Uri.file(state.activeHeader));
  }
  state.activeHeader = headerPath;
  state.activeGeneration = gen;

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
    const headerKey = headerPath.toLowerCase();
    const cachedInspection = state.inspectionCache.get(headerKey);
    const inspectionDiags = inspectionsOn
      ? cachedInspection?.fingerprint === inspectionResult.fingerprint && Date.now() - cachedInspection.at < 30_000
        ? cachedInspection.diagnostics
        : inspectionsToDiagnostics(vscode.Uri.file(headerPath), inspectionResult)
      : [];

    if (inspectionsOn && inspectionDiags !== cachedInspection?.diagnostics) {
      state.inspectionCache.set(headerKey, {
        fingerprint: inspectionResult.fingerprint,
        at: Date.now(),
        diagnostics: inspectionDiags,
      });
    }

    const cachedUht = state.uhtCache.get(ctx.project!.projectRoot.toLowerCase());
    if (cachedUht && Date.now() - cachedUht.at < 30_000) {
      const uri = vscode.Uri.file(headerPath);
      const uhtDiags = cachedUht.byFile.get(headerKey) ?? [];
      publishUhtDiagnostics(ctx, uri, [...inspectionDiags, ...uhtDiags]);
      return;
    }

    const result = await runUhtOnHeader(ctx.project!, ctx.engine!, headerPath, activeToken);
    if (projectSession.isStale(gen) || activeToken.isCancellationRequested || result.stderr === 'cancelled') return;

    const allByFile = groupDiagnosticsByFile(result.allDiagnostics ?? result.diagnostics);
    if (result.cacheKey) {
      state.uhtCache.set(ctx.project!.projectRoot.toLowerCase(), {
        cacheKey: result.cacheKey,
        at: Date.now(),
        byFile: allByFile,
      });
    }

    await publishUhtForManifestFiles(ctx, result.manifestPath, allByFile);

    const uri = vscode.Uri.file(headerPath);
    const uhtDiags = allByFile.get(headerKey) ?? result.diagnostics;
    const all = [...inspectionDiags, ...uhtDiags];
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

async function flushUhtValidation(
  ctx: UE5_8CursorContext,
  projectSession: ProjectSession,
  settings: UE5_8CursorSettings | undefined,
  state: ValidationState,
): Promise<void> {
  const headers = [...state.pendingHeaders];
  state.pendingHeaders.clear();
  for (const header of headers) {
    await validateHeaderNow(ctx, projectSession, header, settings);
  }
}

export function registerUhtSaveValidation(
  resolveRuntime: (uri: vscode.Uri) => UhtValidationRuntime | undefined,
  settings: UE5_8CursorSettings,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'cpp' || !doc.fileName.endsWith('.h')) return;
      const runtime = resolveRuntime(doc.uri);
      if (runtime) scheduleUhtValidation(runtime.ctx, runtime.session, doc.uri.fsPath, settings);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor?.document.fileName.endsWith('.h')) return;
      const runtime = resolveRuntime(editor.document.uri);
      if (runtime) scheduleUhtValidation(runtime.ctx, runtime.session, editor.document.uri.fsPath, settings);
    }),
  );
}

export function clearUhtValidationCache(): void {
  for (const state of validationStates.values()) {
    state.inspectionCache.clear();
    state.uhtCache.clear();
    state.pendingHeaders.clear();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.activeHeader = undefined;
  }
  validationStates.clear();
}
