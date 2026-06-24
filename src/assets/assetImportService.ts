import * as vscode from 'vscode';
import * as path from 'path';
import { mcpCallLogical } from '../blueprint/mcpBlueprintBridge';
import { probeMcpEndpoint } from '../cursor/mcpConfig';

export async function importAssetToContent(
  sourceFile: string,
  destAssetPath: string,
  outputChannel?: vscode.OutputChannel,
): Promise<boolean> {
  const editorUp = await probeMcpEndpoint(8000, 500);
  if (!editorUp) {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: 에디터 MCP가 연결되지 않았습니다. DnD import를 사용하려면 에디터를 실행하세요.',
    );
    return false;
  }

  const absSource = path.resolve(sourceFile);
  outputChannel?.appendLine(`[UE5_8 Cursor] Import ${absSource} -> ${destAssetPath}`);

  const importResult = await mcpCallLogical('importAsset', {
    sourcePath: absSource,
    destPath: destAssetPath,
    assetPath: destAssetPath,
    path: destAssetPath,
  });

  if (importResult.ok) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: Import 완료 → ${destAssetPath}`);
    return true;
  }

  const pyCmd = `py import unreal; unreal.EditorAssetLibrary.import_asset("${absSource.replace(/\\/g, '/')}", "${destAssetPath}")`;
  const fallback = await mcpCallLogical('executeCommand', { command: pyCmd });
  if (fallback.ok) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: Import (Python fallback) → ${destAssetPath}`);
    return true;
  }

  vscode.window.showErrorMessage(
    `UE5_8 Cursor: Import 실패 — ${importResult.error ?? fallback.error ?? 'unknown'}`,
  );
  return false;
}

export async function promptImportDestination(folderHint?: string): Promise<string | undefined> {
  const defaultPath = folderHint ? `/Game/${folderHint}/` : '/Game/Imported/';
  return vscode.window.showInputBox({
    prompt: '대상 에셋 경로 (/Game/...)',
    value: defaultPath,
    placeHolder: '/Game/Imported/MyAsset.MyAsset',
  });
}

export async function importFilesFromDrop(
  filePaths: string[],
  outputChannel?: vscode.OutputChannel,
): Promise<void> {
  for (const file of filePaths) {
    const base = path.basename(file, path.extname(file));
    const dest = await promptImportDestination();
    if (!dest) return;
    const assetPath = dest.includes('.') ? dest : `${dest.replace(/\/$/, '')}/${base}.${base}`;
    await importAssetToContent(file, assetPath, outputChannel);
  }
}
