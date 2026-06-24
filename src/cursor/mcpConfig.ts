import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { mcpJsonRpc } from '../mcp/epicMcpClient';

export const EPIC_MCP_DEFAULT_PORT = 8000;

/** Epic 공식 기본 포트 우선, 레거시 포트 호환 */
export const DEFAULT_MCP_PORT_CANDIDATES = [8000, 13377, 3000, 9315, 13579, 8090, 8091];

export interface McpConfigOptions {
  projectRoot: string;
  port: number;
  serverName?: string;
  extensionMcpScript?: string;
}

function defaultUnrealUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function managedBlock(options: McpConfigOptions): Record<string, unknown> {
  const servers: Record<string, unknown> = {};

  servers[options.serverName ?? 'unreal-engine-58'] = {
    type: 'http',
    url: defaultUnrealUrl(options.port),
  };

  servers['unreal-mcp'] = {
    type: 'http',
    url: defaultUnrealUrl(options.port),
  };

  if (options.extensionMcpScript) {
    servers['ue5-8-cursor'] = {
      command: 'node',
      args: [options.extensionMcpScript],
      env: {
        UE5_8_CURSOR_WORKSPACE: options.projectRoot,
      },
    };
  }

  return servers;
}

function mergeServerEntry(
  existing: Record<string, unknown> | undefined,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return managed;
  const merged = { ...existing };
  for (const [k, v] of Object.entries(managed)) {
    if (typeof v === 'object' && v !== null && typeof merged[k] === 'object' && merged[k] !== null) {
      merged[k] = { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

export async function ensureProjectMcpConfig(options: McpConfigOptions): Promise<boolean> {
  const cursorDir = path.join(options.projectRoot, '.cursor');
  await fs.promises.mkdir(cursorDir, { recursive: true });

  const configPath = path.join(cursorDir, 'mcp.json');
  let existing: { mcpServers?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
  } catch {
    existing = {};
  }

  const servers = { ...(existing.mcpServers ?? {}) };
  const managed = managedBlock(options);
  let changed = false;

  for (const [key, val] of Object.entries(managed)) {
    const merged = mergeServerEntry(
      servers[key] as Record<string, unknown> | undefined,
      val as Record<string, unknown>,
    );
    if (JSON.stringify(servers[key]) !== JSON.stringify(merged)) {
      servers[key] = merged;
      changed = true;
    }
  }

  if (!changed && existing.mcpServers) return false;

  const newContent = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  await fs.promises.writeFile(configPath, newContent, 'utf-8');
  return true;
}

export async function probeMcpEndpoint(port: number, timeoutMs = 2000): Promise<boolean> {
  const json = await mcpJsonRpc(port, 'tools/list', {}, timeoutMs);
  return json !== undefined && !json.error;
}

export async function findActiveMcpPort(candidates: number[] = DEFAULT_MCP_PORT_CANDIDATES): Promise<number | undefined> {
  for (const port of candidates) {
    if (await probeMcpEndpoint(port)) return port;
  }
  return undefined;
}
