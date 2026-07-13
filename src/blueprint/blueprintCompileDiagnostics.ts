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

  const refresh = async () => {
    const bridge = getBridge();
    if (!bridge) {
      collection.delete(diagUri);
      return;
    }
    const errors = await bridge.getBlueprintCompileErrors();
    if (errors.length === 0) {
      collection.delete(diagUri);
      return;
    }

    const diags = errors.map(
      (err) =>
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          err.message,
          vscode.DiagnosticSeverity.Error,
        ),
    );
    collection.set(diagUri, diags);
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
