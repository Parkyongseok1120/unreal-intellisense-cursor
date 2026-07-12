import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import type { UhtDiagnostic } from './uhtRunner';

export const UHT_DIAGNOSTIC_COLLECTION = 'ue58rider-uht';

let uhtCollection: vscode.DiagnosticCollection | undefined;

export function ensureUhtDiagnosticCollection(): vscode.DiagnosticCollection {
  if (!uhtCollection) {
    uhtCollection = vscode.languages.createDiagnosticCollection(UHT_DIAGNOSTIC_COLLECTION);
  }
  return uhtCollection;
}

export function uhtDiagnosticToVscode(d: UhtDiagnostic): vscode.Diagnostic {
  const line = Math.max(0, d.line - 1);
  const col = Math.max(0, d.column - 1);
  const range = new vscode.Range(line, col, line, Math.max(col + 1, 80));
  const severity =
    d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
  const diag = new vscode.Diagnostic(range, d.message, severity);
  diag.source = 'UHT';
  if (d.code) diag.code = d.code;
  return diag;
}

export function publishUhtDiagnostics(
  _ctx: UE5_8CursorContext,
  fileUri: vscode.Uri,
  diagnostics: Array<UhtDiagnostic | vscode.Diagnostic>,
): void {
  const collection = ensureUhtDiagnosticCollection();
  collection.set(
    fileUri,
    diagnostics.map((d) => ('range' in d ? d : uhtDiagnosticToVscode(d))),
  );
}

export function clearUhtDiagnostics(fileUri?: vscode.Uri): void {
  if (!uhtCollection) return;
  if (fileUri) {
    uhtCollection.delete(fileUri);
  } else {
    uhtCollection.clear();
  }
}

export function disposeUhtDiagnostics(): void {
  uhtCollection?.dispose();
  uhtCollection = undefined;
}
