import * as vscode from 'vscode';
import type { EditorBridgeClient } from '../editorBridge/editorBridgeClient';

export function blueprintCompileDiagUri(projectRoot: string): vscode.Uri {
  return vscode.Uri.parse(`unreal://blueprint-compile-errors/${encodeURIComponent(projectRoot)}`);
}

/** @deprecated Use blueprintCompileDiagUri(projectRoot) for multi-root workspaces. */
export const BLUEPRINT_COMPILE_DIAG_URI = blueprintCompileDiagUri('default');

export function startBlueprintCompileDiagnosticsWatch(
  projectRoot: string,
  getBridge: () => EditorBridgeClient | undefined,
  collection: vscode.DiagnosticCollection,
  intervalMs = 60_000,
): vscode.Disposable {
  const diagUri = blueprintCompileDiagUri(projectRoot);
  let lastGoodErrors: Array<{ assetPath: string; message: string }> = [];
  let stale = false;

  const applyErrors = (errors: Array<{ assetPath: string; message: string }>, isStale = false): void => {
    stale = isStale;
    if (errors.length === 0 && !isStale) {
      collection.delete(diagUri);
      lastGoodErrors = [];
      return;
    }
    lastGoodErrors = errors;
    const diags = errors.map(
      (err) =>
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          isStale ? `[stale] ${err.message}` : err.message,
          vscode.DiagnosticSeverity.Error,
        ),
    );
    collection.set(diagUri, diags);
  };

  const refresh = async () => {
    const bridge = getBridge();
    if (!bridge?.isConnected()) {
      if (lastGoodErrors.length) applyErrors(lastGoodErrors, true);
      return;
    }
    const result = await bridge.getBlueprintCompileErrorsResult();
    if (!result.ok) {
      if (lastGoodErrors.length) applyErrors(lastGoodErrors, true);
      return;
    }
    applyErrors(result.value, false);
  };

  const timer = setInterval(() => void refresh(), intervalMs);
  void refresh();
  return { dispose: () => clearInterval(timer) };
}

export function registerBlueprintCompileDiagnostics(
  context: vscode.ExtensionContext,
  collection: vscode.DiagnosticCollection,
): void {
  context.subscriptions.push(collection);
}
