import * as vscode from 'vscode';
import * as path from 'path';
import { parseBuildOutput } from '../parsers/buildOutputParser';
import type { UE5_8CursorContext } from '../types';

export function publishBuildDiagnostics(ctx: UE5_8CursorContext, output: string): void {
  const parsed = parseBuildOutput(output);
  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const d of parsed) {
    const filePath = path.isAbsolute(d.file) ? d.file : path.join(ctx.project?.projectRoot ?? '', d.file);
    const uri = vscode.Uri.file(filePath);
    const key = uri.fsPath;
    const list = byFile.get(key) ?? [];
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(Math.max(0, d.line - 1), Math.max(0, d.column - 1), Math.max(0, d.line - 1), d.column + 80),
      `${d.code}: ${d.message}`,
      d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'UBT';
    diagnostic.code = d.code;
    list.push(diagnostic);
    byFile.set(key, list);
  }

  ctx.diagnosticCollection.clear();
  for (const [filePath, diags] of byFile) {
    ctx.diagnosticCollection.set(vscode.Uri.file(filePath), diags);
  }
}

export function clearBuildDiagnostics(ctx: UE5_8CursorContext): void {
  ctx.diagnosticCollection.clear();
}
