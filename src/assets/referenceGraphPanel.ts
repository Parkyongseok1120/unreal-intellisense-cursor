import * as vscode from 'vscode';
import { buildReferenceGraph, type AssetReferenceBridge } from './assetReferenceService';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderGraphHtml(
  center: string,
  referencers: Array<{ assetPath: string; assetName: string; assetClass?: string }>,
  dependencies: Array<{ assetPath: string; assetName: string; assetClass?: string }>,
  sourceUsages: Array<{ sourceFile?: string; sourceLine?: number; assetPath: string }>,
  editorConnected: boolean,
): string {
  const banner = editorConnected
    ? ''
    : `<div class="banner">Editor MCP offline — Referencers/Dependencies may be incomplete. <button id="launchEditor">Launch Editor</button> <button id="verifyMcp">Verify MCP</button></div>`;

  const refItems = referencers
    .map((r) => `<li data-path="${escapeHtml(r.assetPath)}">${escapeHtml(r.assetName)} <span class="cls">${escapeHtml(r.assetClass ?? '')}</span></li>`)
    .join('') || '<li class="empty">(에디터 MCP 필요 또는 참조 없음)</li>';

  const depItems = dependencies
    .map((d) => `<li data-path="${escapeHtml(d.assetPath)}">${escapeHtml(d.assetName)} <span class="cls">${escapeHtml(d.assetClass ?? '')}</span></li>`)
    .join('') || '<li class="empty">(의존성 없음)</li>';

  const srcItems = sourceUsages
    .map((s) => {
      const loc = s.sourceFile ? `${s.sourceFile.split(/[/\\]/).pop()}:${s.sourceLine}` : '';
      return `<li data-path="${escapeHtml(s.assetPath)}" data-file="${escapeHtml(s.sourceFile ?? '')}" data-line="${s.sourceLine ?? 0}">${escapeHtml(loc)} — ${escapeHtml(s.assetPath)}</li>`;
    })
    .join('') || '<li class="empty">(C++ 소스 사용처 없음)</li>';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  .banner { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px; margin-bottom: 12px; border-radius: 4px; }
  button { margin-left: 8px; }
  h2 { font-size: 14px; margin: 16px 0 8px; }
  .center { font-weight: bold; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 4px 8px; cursor: pointer; border-radius: 3px; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li.empty { cursor: default; opacity: 0.6; }
  .cls { opacity: 0.7; font-size: 11px; margin-left: 6px; }
  .hint { font-size: 11px; opacity: 0.7; margin-top: 12px; }
</style>
</head>
<body>
  ${banner}
  <div class="center">${escapeHtml(center)}</div>
  <h2>Referencers (2-hop max)</h2>
  <ul id="refs">${refItems}</ul>
  <h2>Dependencies</h2>
  <ul id="deps">${depItems}</ul>
  <h2>C++ Source Usages</h2>
  <ul id="src">${srcItems}</ul>
  <p class="hint">Referencers/Dependencies require Unreal Editor MCP (AssetTools).</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('launchEditor')?.addEventListener('click', () => vscode.postMessage({ type: 'launchEditor' }));
    document.getElementById('verifyMcp')?.addEventListener('click', () => vscode.postMessage({ type: 'verifyMcp' }));
    document.querySelectorAll('li[data-path]').forEach(li => {
      if (li.classList.contains('empty')) return;
      li.addEventListener('click', () => {
        const file = li.getAttribute('data-file');
        const line = li.getAttribute('data-line');
        if (file && file.length > 0) {
          vscode.postMessage({ type: 'openSource', file, line: parseInt(line || '0', 10) });
        } else {
          vscode.postMessage({ type: 'openAsset', path: li.getAttribute('data-path') });
        }
      });
    });
  </script>
</body>
</html>`;
}

let panel: vscode.WebviewPanel | undefined;
let openAssetHandler: ((path: string) => void) | undefined;

export async function showReferenceGraphPanel(
  projectRoot: string,
  assetPath: string,
  onOpenAsset: (path: string) => void,
  bridge?: AssetReferenceBridge,
): Promise<void> {
  openAssetHandler = onOpenAsset;
  const graph = await buildReferenceGraph(projectRoot, assetPath, bridge);

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'ue58riderReferenceGraph',
      'Asset References',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: { type: string; path?: string; file?: string; line?: number }) => {
      if (msg.type === 'openAsset' && msg.path) openAssetHandler?.(msg.path);
      if (msg.type === 'launchEditor') void vscode.commands.executeCommand('ue58rider.launchEditor');
      if (msg.type === 'verifyMcp') void vscode.commands.executeCommand('ue58rider.verifyMcp');
      if (msg.type === 'openSource' && msg.file) {
        void vscode.workspace.openTextDocument(msg.file).then((doc) => {
          const line = Math.max(0, (msg.line ?? 1) - 1);
          void vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
        });
      }
    });
  }

  panel.title = `Refs: ${assetPath.split('/').pop()}`;
  panel.webview.html = renderGraphHtml(
    graph.center,
    graph.referencers,
    graph.dependencies,
    graph.sourceUsages,
    graph.editorConnected,
  );
  panel.reveal();
}
