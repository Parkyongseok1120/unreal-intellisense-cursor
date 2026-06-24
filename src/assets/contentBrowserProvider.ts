import * as vscode from 'vscode';
import * as path from 'path';
import { Commands } from '../constants';
import {
  type AssetIndexEntry,
  getOrBuildAssetIndex,
  refreshAssetIndex,
  filterAssetsByClass,
  searchAssets,
} from './assetIndex';
import { themeIconForAssetClass } from './assetClassIcons';

type TreeNode = FolderNode | AssetNode;

interface FolderNode {
  kind: 'folder';
  id: string;
  label: string;
  folderPath: string;
  children?: TreeNode[];
}

interface AssetNode {
  kind: 'asset';
  id: string;
  label: string;
  entry: AssetIndexEntry;
}

export class ContentBrowserProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projectRoot: string | undefined;
  private entries: AssetIndexEntry[] = [];
  private classFilter = 'All';
  private searchQuery = '';
  private tree: FolderNode | undefined;

  setProjectRoot(root: string | undefined): void {
    this.projectRoot = root;
    void this.reload();
  }

  setClassFilter(filter: string): void {
    this.classFilter = filter;
    this.rebuildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.rebuildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  getClassFilter(): string {
    return this.classFilter;
  }

  async reload(): Promise<void> {
    if (!this.projectRoot) {
      this.entries = [];
      this.tree = undefined;
      this._onDidChangeTreeData.fire(undefined);
      return;
    }
    this.entries = await getOrBuildAssetIndex(this.projectRoot);
    this.rebuildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  async refresh(): Promise<void> {
    if (!this.projectRoot) return;
    this.entries = await refreshAssetIndex(this.projectRoot, { enrichMcp: true });
    this.rebuildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  private rebuildTree(): void {
    let filtered = filterAssetsByClass(this.entries, this.classFilter);
    if (this.searchQuery.trim()) {
      filtered = searchAssets(filtered, this.searchQuery);
    }
    const root: FolderNode = {
      kind: 'folder',
      id: 'content-root',
      label: 'Content',
      folderPath: '',
      children: [],
    };

    for (const entry of filtered) {
      const rel = entry.assetPath.replace(/^\/Game\//, '');
      const parts = rel.split('/').slice(0, -1);
      let current = root;
      let currentPath = '';

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        current.children ??= [];
        let child = current.children.find(
          (c): c is FolderNode => c.kind === 'folder' && c.folderPath === currentPath,
        );
        if (!child) {
          child = {
            kind: 'folder',
            id: `folder:${currentPath}`,
            label: part,
            folderPath: currentPath,
            children: [],
          };
          current.children.push(child);
        }
        current = child;
      }

      current.children ??= [];
      current.children.push({
        kind: 'asset',
        id: `asset:${entry.assetPath}`,
        label: entry.assetName,
        entry,
      });
    }

    this.sortTree(root);
    this.tree = root;
  }

  private sortTree(node: FolderNode): void {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    for (const child of node.children) {
      if (child.kind === 'folder') this.sortTree(child);
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = element.id;
      item.contextValue = 'ueContentFolder';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.id = element.id;
    item.contextValue = 'ueContentAsset';
    item.description = element.entry.packageClass ?? element.entry.inferredClass;
    item.tooltip = element.entry.assetPath;
    item.iconPath = themeIconForAssetClass(element.entry.packageClass ?? element.entry.inferredClass);
    item.command = {
      command: Commands.OpenAsset,
      title: 'Open in Editor',
      arguments: [element.entry.assetPath],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.tree) return [];
    if (!element) return this.tree.children ?? [];
    if (element.kind === 'folder') return element.children ?? [];
    return [];
  }

  getEntryForNode(node: TreeNode): AssetIndexEntry | undefined {
    return node.kind === 'asset' ? node.entry : undefined;
  }

  getProjectRoot(): string | undefined {
    return this.projectRoot;
  }
}

export function registerContentBrowser(context: vscode.ExtensionContext): ContentBrowserProvider {
  const provider = new ContentBrowserProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ue58rider.contentBrowser', provider),
  );
  return provider;
}

export async function copyAssetPath(entry: AssetIndexEntry): Promise<void> {
  await vscode.env.clipboard.writeText(entry.assetPath);
  vscode.window.showInformationMessage(`복사됨: ${entry.assetPath}`);
}

export const CLASS_FILTER_OPTIONS = ['All', 'Blueprint', 'Material', 'StaticMesh', 'World', 'WidgetBlueprint'] as const;

export async function pickClassFilter(current: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick([...CLASS_FILTER_OPTIONS], {
    placeHolder: `Class filter (current: ${current})`,
  });
  return picked;
}

export async function promptAssetSearch(provider: ContentBrowserProvider): Promise<void> {
  const query = await vscode.window.showInputBox({
    placeHolder: 'Search assets by name or path...',
    value: '',
  });
  if (query === undefined) return;
  provider.setSearchQuery(query);
}
