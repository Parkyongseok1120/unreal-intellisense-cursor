import * as vscode from 'vscode';
import { suggestedQuickFixes, type UhtDiagnostic } from './uhtRunner';
import { ensureUhtDiagnosticCollection } from './uhtDiagnostics';

const SAFE_FIX_PREFIXES = ['GENERATED_BODY', 'UFUNCTION'];

export class UhtCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const collection = ensureUhtDiagnosticCollection();
    const fileDiags = collection.get(document.uri) ?? [];
    const relevant = context.diagnostics.length > 0 ? context.diagnostics : fileDiags;
    const actions: vscode.CodeAction[] = [];

    for (const diag of relevant) {
      if (diag.source !== 'UHT') continue;
      const uhtDiag: UhtDiagnostic = {
        file: document.uri.fsPath,
        line: range.start.line + 1,
        column: range.start.character + 1,
        severity: diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: diag.message,
        code: typeof diag.code === 'string' ? diag.code : undefined,
      };

      for (const fixLabel of suggestedQuickFixes(uhtDiag)) {
        if (!isSafeQuickFix(fixLabel)) continue;

        const action = new vscode.CodeAction(fixLabel, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diag];

        if (fixLabel.includes('GENERATED_BODY')) {
          action.edit = buildGeneratedBodyEdit(document, range);
        } else if (fixLabel.includes('UFUNCTION')) {
          action.edit = buildUfunctionEdit(document, range);
        }

        if (action.edit) actions.push(action);
      }
    }

    return actions;
  }
}

export function isSafeQuickFix(label: string): boolean {
  if (label.includes('Implementation')) return false;
  return SAFE_FIX_PREFIXES.some((prefix) => label.includes(prefix));
}

function buildGeneratedBodyEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
): vscode.WorkspaceEdit | undefined {
  const line = document.lineAt(range.start.line).text;
  if (line.includes('GENERATED_BODY')) return undefined;

  const edit = new vscode.WorkspaceEdit();
  const insertPos = new vscode.Position(range.start.line, 0);
  edit.insert(document.uri, insertPos, '\tGENERATED_BODY()\n');
  return edit;
}

function buildUfunctionEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
): vscode.WorkspaceEdit | undefined {
  const lineText = document.lineAt(range.start.line).text;
  if (lineText.includes('UFUNCTION')) return undefined;

  const edit = new vscode.WorkspaceEdit();
  const insertPos = new vscode.Position(range.start.line, 0);
  edit.insert(document.uri, insertPos, '\tUFUNCTION(BlueprintCallable)\n');
  return edit;
}
