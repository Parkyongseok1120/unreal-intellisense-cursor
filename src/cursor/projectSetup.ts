import * as path from 'path';
import { ensureClangdConfig } from './clangdConfig';
import { ensureUhtStubs, discoverIntermediateIncludePaths, discoverModuleIncludePaths } from './uhtIntellisense';
import {
  ensureProjectMcpConfig,
  findActiveMcpPort,
  DEFAULT_MCP_PORT_CANDIDATES,
  EPIC_MCP_DEFAULT_PORT,
} from './mcpConfig';
import { findActiveMcpPortWithMode } from '../mcp/epicMcpClient';
import { refreshProjectMcpSchema } from '../mcp/schemaRegistry';
import { configureMcpBridge } from '../blueprint/mcpBlueprintBridge';
import { getMissingMcpPlugins, parseUProjectFull, ensureMcpPluginsInUProject } from '../parsers/uprojectParser';
import type { UEProject } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

export async function ensureUhtIntellisense(
  project: UEProject,
  extensionPath: string,
): Promise<{ stubs: boolean; clangd: boolean }> {
  const stubsPath = await ensureUhtStubs(project.projectRoot, extensionPath);
  const [intermediateIncludes, moduleIncludes] = await Promise.all([
    discoverIntermediateIncludePaths(project.projectRoot),
    discoverModuleIncludePaths(project.projectRoot),
  ]);
  const clangd = await ensureClangdConfig(project.projectRoot, {
    stubsPath,
    intermediateIncludes: [...moduleIncludes, ...intermediateIncludes],
  });
  return { stubs: true, clangd };
}

export async function ensureMcpIntegration(
  project: UEProject,
  extensionPath: string,
  settings: UE5_8CursorSettings,
): Promise<{ configured: boolean; activePort?: number; mode?: string; schemaRefreshed?: boolean }> {
  if (!settings.mcpEnabled) return { configured: false };

  configureMcpBridge(project.projectRoot, extensionPath);

  const preferred =
    settings.mcpPort ||
    (await findActiveMcpPort(DEFAULT_MCP_PORT_CANDIDATES)) ||
    settings.mcpPortDefault ||
    EPIC_MCP_DEFAULT_PORT;

  const mcpScript = path.join(extensionPath, 'dist', 'mcp-server.js');
  const configured = await ensureProjectMcpConfig({
    projectRoot: project.projectRoot,
    port: preferred,
    extensionMcpScript: mcpScript,
  });

  const found = await findActiveMcpPortWithMode([
    preferred,
    ...DEFAULT_MCP_PORT_CANDIDATES.filter((p) => p !== preferred),
  ]);

  let schemaRefreshed = false;
  if (found?.port) {
    try {
      await refreshProjectMcpSchema(project.projectRoot, found.port, extensionPath);
      schemaRefreshed = true;
    } catch {
      // editor may not expose all toolsets yet
    }
  }

  try {
    const uproject = await parseUProjectFull(project.uprojectPath);
    const missing = getMissingMcpPlugins(uproject.Plugins ?? []);
    if (missing.length > 0 && settings.mcpAutoFixUproject) {
      await ensureMcpPluginsInUProject(project.uprojectPath);
    }
  } catch {
    // ignore
  }

  return {
    configured,
    activePort: found?.port,
    mode: found?.mode,
    schemaRefreshed,
  };
}
