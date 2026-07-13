import * as vscode from 'vscode';
import {
  loadAssetIndex,
  searchAssets,
  filterAssetsByClass,
  type AssetIndexEntry,
} from './assetIndex';
import { CLASS_FILTER_OPTIONS } from './contentBrowserProvider';
import { offlineThumbnailBadge } from './assetThumbnailService';
import { probeMcpEndpoint } from '../cursor/mcpConfig';
import type { UE5_8CursorSettings } from '../config/settings';
import { Commands } from '../constants';

const PAGE_SIZE = 100;
const WINDOW_ROWS = 4;
const ROW_HEIGHT = 110;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCard(entry: AssetIndexEntry): string {
  const cls = entry.packageClass ?? entry.inferredClass ?? '';
  const thumb = entry.thumbnailUri
    ? `<img class="thumb" src="${escapeHtml(entry.thumbnailUri)}" alt="" />`
    : `<div class="thumb badge">${escapeHtml(offlineThumbnailBadge(entry))}</div>`;
  return `<div class="card" data-path="${escapeHtml(entry.assetPath)}">
    ${thumb}
    <div class="name">${escapeHtml(entry.assetName)}</div>
    <div class="cls">${escapeHtml(cls)}</div>
  </div>`;
}

let activePanel: vscode.WebviewPanel | undefined;

export async function showContentBrowserWebview(
  projectRoot: string,
  onOpenAsset: (path: string) => void,
  extensionContext?: vscode.ExtensionContext,
  settings?: UE5_8CursorSettings,
): Promise<void> {
  const entries = await loadAssetIndex(projectRoot);
  const editorConnected = await probeMcpEndpoint(8000, 500);
  const dndEnabled = settings?.experimentalAssetImportDnD ?? false;

  if (activePanel) {
    activePanel.reveal();
    updateWebview(activePanel, entries, editorConnected, dndEnabled);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'ue58riderContentWebview',
    'UE Content (Grid)',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: extensionContext
        ? [vscode.Uri.file(extensionContext.extensionPath), vscode.Uri.file(projectRoot)]
        : [vscode.Uri.file(projectRoot)],
    },
  );
  activePanel = panel;

  panel.onDidDispose(() => {
    activePanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg: {
    type: string;
    path?: string;
    page?: number;
    query?: string;
    filter?: string;
    filePaths?: string[];
  }) => {
    if (msg.type === 'open' && msg.path) onOpenAsset(msg.path);
    if (msg.type === 'refs' && msg.path) {
      void vscode.commands.executeCommand(Commands.FindAssetReferences, msg.path);
    }
    if (msg.type === 'copy' && msg.path) {
      await vscode.env.clipboard.writeText(msg.path);
      vscode.window.showInformationMessage(`복사됨: ${msg.path}`);
    }
    if (msg.type === 'filter' || msg.type === 'search' || msg.type === 'page' || msg.type === 'scroll') {
      const filtered = applyFilters(entries, msg.filter ?? 'All', msg.query ?? '');
      const scrollTop = msg.scrollTop ?? 0;
      panel.webview.html = buildHtml(filtered, scrollTop, editorConnected, dndEnabled, msg.filter ?? 'All', msg.query ?? '');
    }
    if (msg.type === 'drop' && msg.filePaths?.length) {
      const { importFilesFromDrop } = await import('./assetImportService');
      await importFilesFromDrop(msg.filePaths);
    }
    if (msg.type === 'pickImport') {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: true });
      if (uris?.length) {
        const { importFilesFromDrop } = await import('./assetImportService');
        await importFilesFromDrop(uris.map((u) => u.fsPath));
      }
    }
  });

  updateWebview(panel, entries, editorConnected, dndEnabled);
}

function applyFilters(entries: AssetIndexEntry[], classFilter: string, query: string): AssetIndexEntry[] {
  let filtered = filterAssetsByClass(entries, classFilter);
  if (query.trim()) filtered = searchAssets(filtered, query);
  return filtered;
}

function updateWebview(
  panel: vscode.WebviewPanel,
  entries: AssetIndexEntry[],
  editorConnected: boolean,
  dndEnabled: boolean,
): void {
  panel.webview.html = buildHtml(entries, 0, editorConnected, dndEnabled, 'All', '');
}

function buildHtml(
  entries: AssetIndexEntry[],
  scrollTop: number,
  editorConnected: boolean,
  dndEnabled: boolean,
  classFilter: string,
  query: string,
): string {
  const filtered = applyFilters(entries, classFilter, query);
  const cols = 6;
  const totalRows = Math.max(1, Math.ceil(filtered.length / cols));
  const viewportRows = WINDOW_ROWS + 2;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 1);
  const endRow = Math.min(totalRows, startRow + viewportRows);
  const startIndex = startRow * cols;
  const endIndex = Math.min(filtered.length, endRow * cols);
  const slice = filtered.slice(startIndex, endIndex);
  const cards = slice.map(renderCard).join('');
  const topSpacer = startRow * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, (totalRows - endRow) * ROW_HEIGHT);
  const filterOptions = CLASS_FILTER_OPTIONS.map(
    (o) => `<option value="${o}"${o === classFilter ? ' selected' : ''}>${o}</option>`,
  ).join('');

  const banner = editorConnected
    ? ''
    : `<div class="banner">Editor MCP offline — thumbnails may be unavailable.</div>`;

  const dropZone = dndEnabled
    ? `<div class="dropzone" id="dropzone">Drop files to import (experimental) — or <button id="pickImport">Browse...</button></div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .banner { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px; margin-bottom: 8px; border-radius: 4px; font-size: 12px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
  .toolbar input, .toolbar select { padding: 4px 8px; flex: 1; min-width: 120px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .scroll { max-height: 70vh; overflow-y: auto; }
  .card { border: 1px solid var(--vscode-panel-border); padding: 6px; border-radius: 4px; cursor: pointer; text-align: center; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .thumb { width: 64px; height: 64px; object-fit: contain; margin: 0 auto 4px; display: block; }
  .thumb.badge { width: 64px; height: 64px; line-height: 64px; font-weight: bold; font-size: 18px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; margin: 0 auto 4px; }
  .name { font-weight: 600; font-size: 11px; word-break: break-all; }
  .cls { font-size: 10px; opacity: 0.7; }
  .pager { margin-top: 12px; display: flex; gap: 8px; align-items: center; font-size: 12px; }
  .dropzone { border: 2px dashed var(--vscode-panel-border); padding: 12px; margin-bottom: 8px; text-align: center; font-size: 12px; border-radius: 4px; }
  .dropzone.drag { background: var(--vscode-list-hoverBackground); }
  .ctx { position: fixed; display: none; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); padding: 4px 0; z-index: 9; }
  .ctx button { display: block; width: 100%; text-align: left; padding: 4px 12px; background: none; border: none; color: var(--vscode-menu-foreground); cursor: pointer; }
  .ctx button:hover { background: var(--vscode-menu-selectionBackground); }
</style></head>
<body>
  ${banner}
  ${dropZone}
  <div class="toolbar">
    <input id="q" placeholder="Search..." value="${escapeHtml(query)}" />
    <select id="classFilter">${filterOptions}</select>
  </div>
  <div class="scroll" id="scroll">
    <div style="height:${topSpacer}px" id="topSpacer"></div>
    <div class="grid" id="grid">${cards}</div>
    <div style="height:${bottomSpacer}px" id="bottomSpacer"></div>
  </div>
  <div class="pager">
    <span>${filtered.length} assets · virtual window rows ${startRow + 1}-${endRow} / ${totalRows}</span>
  </div>
  <div class="ctx" id="ctx">
    <button data-act="open">Open in Editor</button>
    <button data-act="refs">Find References</button>
    <button data-act="copy">Copy Path</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let ctxPath = '';
    const post = (type, extra) => vscode.postMessage({ type, ...extra });

    document.getElementById('q').addEventListener('input', (e) => {
      post('search', { query: e.target.value, filter: document.getElementById('classFilter').value, scrollTop: 0 });
    });
    document.getElementById('classFilter').addEventListener('change', (e) => {
      post('filter', { filter: e.target.value, query: document.getElementById('q').value, scrollTop: 0 });
    });
    let scrollTimer;
    document.getElementById('scroll')?.addEventListener('scroll', (e) => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        post('scroll', {
          scrollTop: e.target.scrollTop,
          filter: document.getElementById('classFilter').value,
          query: document.getElementById('q').value,
        });
      }, 80);
    });
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          post('scroll', {
            scrollTop: document.getElementById('scroll')?.scrollTop ?? 0,
            filter: document.getElementById('classFilter').value,
            query: document.getElementById('q').value,
          });
        }
      }
    }, { root: document.getElementById('scroll'), rootMargin: '200px' });
    document.getElementById('topSpacer') && observer.observe(document.getElementById('topSpacer'));
    document.getElementById('bottomSpacer') && observer.observe(document.getElementById('bottomSpacer'));

    document.querySelectorAll('.card').forEach(c => {
      c.addEventListener('click', (e) => {
        if (e.button === 2) return;
        post('open', { path: c.getAttribute('data-path') });
      });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        ctxPath = c.getAttribute('data-path');
        const ctx = document.getElementById('ctx');
        ctx.style.display = 'block';
        ctx.style.left = e.clientX + 'px';
        ctx.style.top = e.clientY + 'px';
      });
    });
    document.getElementById('ctx').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'open') post('open', { path: ctxPath });
      if (act === 'refs') post('refs', { path: ctxPath });
      if (act === 'copy') post('copy', { path: ctxPath });
      document.getElementById('ctx').style.display = 'none';
    });
    document.body.addEventListener('click', () => { document.getElementById('ctx').style.display = 'none'; });

    const dz = document.getElementById('dropzone');
    if (dz) {
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('drag');
        post('pickImport', {});
      });
      document.getElementById('pickImport')?.addEventListener('click', () => post('pickImport', {}));
    }
  </script>
</body></html>`;
}

export async function searchAssetsQuickPick(projectRoot: string): Promise<string | undefined> {
  const entries = await loadAssetIndex(projectRoot);
  const query = await vscode.window.showInputBox({ placeHolder: 'Search assets...' });
  if (!query) return undefined;
  const matches = searchAssets(entries, query).slice(0, 50);
  const picked = await vscode.window.showQuickPick(
    matches.map((e) => ({ label: e.assetName, description: e.assetPath, path: e.assetPath })),
    { placeHolder: 'Select asset' },
  );
  return picked?.path;
}
