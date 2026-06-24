import * as vscode from 'vscode';
import { findPairedSourceFile } from '../platform/paths';

export async function switchHeaderSource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentPath = editor.document.uri.fsPath;
  const paired = findPairedSourceFile(currentPath);

  if (!paired) {
    vscode.window.showInformationMessage('UE5_8 Cursor: 대응하는 헤더/소스 파일을 찾을 수 없습니다.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(paired);
  await vscode.window.showTextDocument(doc, editor.viewColumn);
}
