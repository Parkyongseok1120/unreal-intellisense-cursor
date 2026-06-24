import * as vscode from 'vscode';
import * as path from 'path';
import { Commands } from '../constants';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class UprojectDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    // readonly — nothing to release
  }
}

class UprojectCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<UprojectDocument> {
  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: { backupId?: string },
    _token: vscode.CancellationToken,
  ): Promise<UprojectDocument> {
    return new UprojectDocument(uri);
  }

  async resolveCustomEditor(
    document: UprojectDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const uprojectPath = document.uri.fsPath;
    const projectRoot = path.dirname(uprojectPath);
    const projectName = escapeHtml(path.basename(uprojectPath, '.uproject'));

    webviewPanel.webview.options = { enableScripts: false };
    webviewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);padding:1.5rem;color:var(--vscode-foreground);}
h2{margin:0 0 .5rem;}
p{opacity:.85;}
</style></head><body>
<h2>UE5_8 Cursor — ${projectName}</h2>
<p>프로젝트 폴더를 열고 IntelliSense를 자동 설정합니다…</p>
</body></html>`;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && path.normalize(workspaceRoot) === path.normalize(projectRoot)) {
      await vscode.commands.executeCommand(Commands.SetupProject);
      return;
    }

    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectRoot), false);
  }
}

export function registerUprojectOpenHandler(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('ue58rider.uproject', new UprojectCustomEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.OpenUproject, async (uri?: vscode.Uri) => {
      let target = uri;
      if (!target && vscode.window.activeTextEditor?.document.fileName.endsWith('.uproject')) {
        target = vscode.window.activeTextEditor.document.uri;
      }
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          filters: { 'Unreal Project': ['uproject'] },
          canSelectMany: false,
        });
        target = picked?.[0];
      }
      if (!target) return;

      const projectRoot = path.dirname(target.fsPath);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot && path.normalize(workspaceRoot) === path.normalize(projectRoot)) {
        await vscode.commands.executeCommand(Commands.SetupProject);
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectRoot), false);
    }),
  );
}
