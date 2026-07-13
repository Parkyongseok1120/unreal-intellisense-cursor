import * as vscode from 'vscode';
import { findPairedSourceFile } from '../parsers/moduleLayout';

export async function switchHeaderSource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentPath = editor.document.uri.fsPath;
  const paired = findPairedSourceFile(currentPath);

  if (!paired) {
    vscode.window.showInformationMessage('UE5_8 Cursor: ?€?‘í•˜???¤ë”/?ŒìŠ¤ ?Œì¼??ì°¾ì„ ???†ìŠµ?ˆë‹¤.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(paired);
  await vscode.window.showTextDocument(doc, editor.viewColumn);
}
