import * as vscode from 'vscode';
import { parseUClassFromText } from '../blueprint/cppClassParser';
import { findUFunctionBlueprintUsages, pickAndOpenUFunctionUsage } from '../blueprint/ufunctionBlueprintFinder';
import type { UE5_8CursorContext } from '../types';

export function findOwningClassName(documentText: string, functionLine: number): string | undefined {
  const classes = parseUClassFromText(documentText);
  let best: { className: string; line: number } | undefined;
  for (const cls of classes) {
    if (cls.line <= functionLine && (!best || cls.line > best.line)) {
      best = { className: cls.className, line: cls.line };
    }
  }
  return best?.className;
}

export async function findUFunctionBlueprints(
  ctx: UE5_8CursorContext,
  functionName: string,
  className?: string,
  documentPath?: string,
): Promise<void> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트가 없습니다.');
    return;
  }

  let ownerClass = className;
  if (!ownerClass && documentPath) {
    try {
      const doc = await vscode.workspace.openTextDocument(documentPath);
      const editor = vscode.window.activeTextEditor;
      const line = editor?.document.fileName === documentPath ? editor.selection.active.line : 0;
      ownerClass = findOwningClassName(doc.getText(), line);
    } catch {
      // ignore
    }
  }

  if (!ownerClass) {
    ownerClass = await vscode.window.showInputBox({
      prompt: 'UFUNCTION이 속한 C++ 클래스 이름 (e.g. AEnemyCharacter)',
    });
  }
  if (!ownerClass) return;

  const usages = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `BP usages: ${ownerClass}::${functionName}` },
    () => findUFunctionBlueprintUsages(ctx.project!, ctx.engine, ownerClass!, functionName),
  );

  if (usages.length === 0) {
    vscode.window.showInformationMessage(
      `UE5_8 Cursor: ${ownerClass}::${functionName} Blueprint 사용처 없음 (MCP/휴리스틱)`,
    );
    return;
  }

  if (!ctx.engine) {
    const list = usages.map((u) => u.assetPath).join('\n');
    vscode.window.showInformationMessage(`Blueprint 사용처 ${usages.length}개`, { modal: true, detail: list });
    return;
  }

  await pickAndOpenUFunctionUsage(ctx.project, ctx.engine, usages);
}
