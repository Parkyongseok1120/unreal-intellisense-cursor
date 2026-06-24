import * as vscode from 'vscode';
import {
  findActiveMcpPortWithMode,
  listToolsets,
} from './epicMcpClient';
import { DEFAULT_MCP_PORT_CANDIDATES } from '../cursor/mcpConfig';
import { loadResolvedTools } from './runtimeToolResolver';
import { loadProjectSchema } from './schemaRegistry';
import type { LogicalToolName } from './schemaRegistry';

export interface McpDiagnosticsSnapshot {
  port?: number;
  mode?: string;
  toolsetCount: number;
  toolsets: string[];
  resolvedCount: number;
  failedLogical: LogicalToolName[];
  schemaCapturedAt?: string;
}

export async function collectMcpDiagnostics(projectRoot: string, port?: number): Promise<McpDiagnosticsSnapshot> {
  const activePort =
    port ??
    (await findActiveMcpPortWithMode(DEFAULT_MCP_PORT_CANDIDATES))?.port;

  if (!activePort) {
    return { toolsetCount: 0, toolsets: [], resolvedCount: 0, failedLogical: [] };
  }

  const found = await findActiveMcpPortWithMode([activePort]);
  const toolsets = await listToolsets(activePort);
  const resolved = await loadResolvedTools(projectRoot);
  const schema = await loadProjectSchema(projectRoot);

  return {
    port: activePort,
    mode: found?.mode,
    toolsetCount: toolsets.length,
    toolsets,
    resolvedCount: resolved ? Object.keys(resolved.resolved).length : 0,
    failedLogical: resolved?.failed ?? [],
    schemaCapturedAt: schema?.capturedAt,
  };
}

export async function showMcpDiagnostics(
  projectRoot: string,
  outputChannel?: vscode.OutputChannel,
): Promise<void> {
  const diag = await collectMcpDiagnostics(projectRoot);
  const lines = [
    '=== UE5_8 Cursor MCP Diagnostics ===',
    `Port: ${diag.port ?? 'not connected'}`,
    `Mode: ${diag.mode ?? 'unknown'}`,
    `Toolsets: ${diag.toolsetCount}`,
    diag.toolsets.length > 0 ? `  ${diag.toolsets.join(', ')}` : '  (none)',
    `Resolved logical tools: ${diag.resolvedCount}`,
    diag.failedLogical.length > 0 ? `Failed: ${diag.failedLogical.join(', ')}` : 'Failed: (none)',
    `Schema captured: ${diag.schemaCapturedAt ?? 'never'}`,
  ];

  const text = lines.join('\n');
  if (outputChannel) {
    outputChannel.appendLine(text);
    outputChannel.show(true);
  }

  await vscode.window.showInformationMessage(
    diag.port
      ? `MCP ${diag.port} (${diag.mode}) — ${diag.resolvedCount} tools resolved`
      : 'MCP server not connected',
    'Refresh Schema',
    'Verify MCP',
  ).then((c) => {
    if (c === 'Refresh Schema') void vscode.commands.executeCommand('ue58rider.refreshMcpSchema');
    if (c === 'Verify MCP') void vscode.commands.executeCommand('ue58rider.verifyMcp');
  });
}

interface DiagnosticsTreeItem {
  label: string;
  description?: string;
  children?: DiagnosticsTreeItem[];
}

export class McpDiagnosticsProvider implements vscode.TreeDataProvider<DiagnosticsTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private snapshot: McpDiagnosticsSnapshot | undefined;

  constructor(private projectRoot: () => string | undefined) {}

  async refresh(): Promise<void> {
    const root = this.projectRoot();
    if (!root) {
      this.snapshot = undefined;
    } else {
      this.snapshot = await collectMcpDiagnostics(root);
    }
    this._onDidChange.fire();
  }

  getTreeItem(element: DiagnosticsTreeItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = element.description;
    return item;
  }

  getChildren(element?: DiagnosticsTreeItem): DiagnosticsTreeItem[] {
    if (element?.children) return element.children;
    if (!this.snapshot) {
      return [{ label: 'No project / MCP offline' }];
    }
    const s = this.snapshot;
    return [
      {
        label: 'Connection',
        children: [
          { label: 'Port', description: String(s.port ?? 'off') },
          { label: 'Mode', description: s.mode ?? 'unknown' },
        ],
      },
      {
        label: 'Toolsets',
        description: String(s.toolsetCount),
        children: s.toolsets.map((t) => ({ label: t })),
      },
      {
        label: 'Resolved tools',
        description: String(s.resolvedCount),
        children: s.failedLogical.map((f) => ({ label: f, description: 'failed' })),
      },
    ];
  }
}

export function registerMcpDiagnostics(context: vscode.ExtensionContext, projectRoot: () => string | undefined): McpDiagnosticsProvider {
  const provider = new McpDiagnosticsProvider(projectRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ue58rider.mcpDiagnostics', provider),
  );
  return provider;
}
