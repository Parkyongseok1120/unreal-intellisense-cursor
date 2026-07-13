import * as vscode from 'vscode';
import type { EditorBridgeClient } from '../editorBridge/editorBridgeClient';

export const BLUEPRINT_COMPILE_DIAG_URI = vscode.Uri.parse('unreal://blueprint-compile-errors');

export function startBlueprintCompileDiagnosticsWatch(
  getBridge: () => EditorBridgeClient | undefined,
  collection: vscode.DiagnosticCollection,
  intervalMs = 60_000,
): vscode.Disposable {
  const refresh = async () => {
    const bridge = getBridge();
    if (!bridge) {
      collection.delete(BLUEPRINT_COMPILE_DIAG_URI);
      return;
    }
    const errors = await bridge.getBlueprintCompileErrors();
    if (errors.length === 0) {
      collection.delete(BLUEPRINT_COMPILE_DIAG_URI);
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
    collection.set(BLUEPRINT_COMPILE_DIAG_URI, diags);
  };

  const timer = setInterval(() => void refresh(), intervalMs);
  void refresh();
  return { dispose: () => clearInterval(timer) };
}

export function registerBlueprintCompileDiagnostics(
  context: vscode.ExtensionContext,
  getBridge: () => EditorBridgeClient | undefined,
  collection: vscode.DiagnosticCollection,
): void {
  context.subscriptions.push(startBlueprintCompileDiagnosticsWatch(getBridge, collection));
}
