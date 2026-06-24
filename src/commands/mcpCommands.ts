import * as vscode from 'vscode';
import {
  findActiveMcpPort,
  DEFAULT_MCP_PORT_CANDIDATES,
  EPIC_MCP_DEFAULT_PORT,
  ensureProjectMcpConfig,
} from '../cursor/mcpConfig';
import { findActiveMcpPortWithMode, listToolsets } from '../mcp/epicMcpClient';
import { refreshProjectMcpSchema } from '../mcp/schemaRegistry';
import { configureMcpBridge } from '../blueprint/mcpBlueprintBridge';
import {
  getMissingMcpPlugins,
  parseUProjectFull,
  ensureMcpPluginsInUProject,
} from '../parsers/uprojectParser';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

export async function verifyMcpConnection(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
): Promise<void> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트가 없습니다.');
    return;
  }

  configureMcpBridge(ctx.project.projectRoot, extensionPath);

  const port = settings.mcpPort || settings.mcpPortDefault || EPIC_MCP_DEFAULT_PORT;
  const found = await findActiveMcpPortWithMode([port, ...DEFAULT_MCP_PORT_CANDIDATES.filter((p) => p !== port)]);

  if (found) {
    const toolsets = await listToolsets(found.port);
    await ensureProjectMcpConfig({
      projectRoot: ctx.project.projectRoot,
      port: found.port,
      extensionMcpScript: `${extensionPath}/dist/mcp-server.js`.replace(/\\/g, '/'),
    });

    const pluginWarnings = await checkMcpPlugins(ctx.project.uprojectPath);
    const toolsetInfo = toolsets.length > 0 ? `${toolsets.length} toolsets` : 'meta-tools only';
    vscode.window.showInformationMessage(
      `UE5_8 Cursor: UE MCP 연결됨 (포트 ${found.port}, ${found.mode}, ${toolsetInfo})${pluginWarnings}`,
      '리로드',
      '스키마 갱신',
    ).then(async (c) => {
      if (c === '리로드') vscode.commands.executeCommand('workbench.action.reloadWindow');
      if (c === '스키마 갱신') await refreshMcpSchema(ctx, settings, extensionPath);
    });
  } else {
    vscode.window.showWarningMessage(
      'UE5_8 Cursor: UE MCP 서버에 연결할 수 없습니다. ModelContextProtocol + AllToolsets 플러그인을 활성화하고 에디터를 실행하세요.',
      '플러그인 추가',
      '도움말',
    ).then(async (c) => {
      if (c === '플러그인 추가' && ctx.project) {
        const changed = await ensureMcpPluginsInUProject(ctx.project.uprojectPath);
        vscode.window.showInformationMessage(
          changed
            ? '.uproject에 MCP 플러그인 항목이 추가되었습니다. 에디터를 재시작하세요.'
            : '플러그인 항목이 이미 있습니다.',
        );
      }
      if (c === '도움말') {
        vscode.window.showInformationMessage(
          'UE 5.8: Plugins → Unreal MCP + AllToolsets 활성화 → Auto Start Server → 포트 8000',
          { modal: true },
        );
      }
    });
  }
}

async function checkMcpPlugins(uprojectPath: string): Promise<string> {
  try {
    const data = await parseUProjectFull(uprojectPath);
    const missing = getMissingMcpPlugins(data.Plugins ?? []);
    if (missing.length === 0) return '';
    return ` — 누락 플러그인: ${missing.join(', ')}`;
  } catch {
    return '';
  }
}

export async function refreshMcpSchema(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
): Promise<void> {
  if (!ctx.project) return;

  const port =
    (await findActiveMcpPort([settings.mcpPort, settings.mcpPortDefault, ...DEFAULT_MCP_PORT_CANDIDATES].filter(Boolean))) ??
    settings.mcpPortDefault;

  if (!port) {
    vscode.window.showWarningMessage('UE5_8 Cursor: MCP 서버가 실행 중이 아닙니다.');
    return;
  }

  configureMcpBridge(ctx.project.projectRoot, extensionPath);
  const schema = await refreshProjectMcpSchema(ctx.project.projectRoot, port, extensionPath);
  const toolsetCount = Object.keys(schema.toolsets).length;
  const { refreshAllIndexes } = await import('../assets/indexCoordinator');
  await refreshAllIndexes(ctx.project.projectRoot, { enrichMcp: true, skipReflection: true });
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] MCP schema refreshed (${toolsetCount} toolsets)`);
  vscode.window.showInformationMessage(`UE5_8 Cursor: MCP 스키마 갱신 완료 (${toolsetCount} toolsets)`);
}

export async function setupMcpConfig(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
): Promise<void> {
  const { ensureMcpIntegration } = await import('../cursor/projectSetup');
  if (!ctx.project) return;
  configureMcpBridge(ctx.project.projectRoot, extensionPath);
  const result = await ensureMcpIntegration(ctx.project, extensionPath, settings);
  if (result.configured) {
    ctx.outputChannel.appendLine(
      `[UE5_8 Cursor] .cursor/mcp.json configured (port ${settings.mcpPort || settings.mcpPortDefault})`,
    );
  }
  if (result.activePort) {
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] UE MCP active on port ${result.activePort} (${result.mode})`);
    if (result.schemaRefreshed) {
      ctx.outputChannel.appendLine('[UE5_8 Cursor] MCP schema snapshot saved');
    }
  }

  const missing = await checkMcpPlugins(ctx.project.uprojectPath);
  if (missing) {
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Warning${missing}`);
  }
}
