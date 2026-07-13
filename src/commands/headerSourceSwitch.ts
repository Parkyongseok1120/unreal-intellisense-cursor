import * as path from 'path';
import * as vscode from 'vscode';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import { getSymbolAtPosition } from '../navigation/symbolNavigation';

export async function switchHeaderSource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('UE5_8 Cursor: No active editor.');
    return;
  }

  const currentPath = editor.document.uri.fsPath;
  const paired = findPairedSourceFile(currentPath);

  if (!paired) {
    vscode.window.showInformationMessage('UE5_8 Cursor: No paired header/source file found.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(paired);
  const symbol = getSymbolAtPosition(editor.document, editor.selection.active);
  const targetEditor = await vscode.window.showTextDocument(doc, editor.viewColumn);
  if (symbol) {
    const text = targetEditor.document.getText();
    const pattern = new RegExp(`\\b${symbol.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const index = text.search(pattern);
    if (index >= 0) {
      const position = targetEditor.document.positionAt(index);
      targetEditor.selection = new vscode.Selection(position, position);
      targetEditor.revealRange(new vscode.Range(position, position));
    }
  }
}
