import * as http from 'http';
import { EPIC_MCP_DEFAULT_PORT, DEFAULT_MCP_PORT_CANDIDATES } from './mcpPorts';

export interface McpJsonRpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };
  error?: { message: string; code?: number };
}

export interface McpCallResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export type McpServerMode = 'tool-search' | 'legacy-flat' | 'unknown';

let cachedMode: McpServerMode | undefined;
let cachedModePort: number | undefined;

export function resetMcpModeCache(): void {
  cachedMode = undefined;
  cachedModePort = undefined;
}

function extractText(json: McpJsonRpcResponse): string | undefined {
  const text = json.result?.content?.find((c) => c.type === 'text')?.text;
  return text;
}

export async function mcpJsonRpc(
  port: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<McpJsonRpcResponse | undefined> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as McpJsonRpcResponse);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.write(body);
    req.end();
  });
}

export async function callMcpTool(
  port: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const json = await mcpJsonRpc(port, 'tools/call', { name: toolName, arguments: args });
  if (!json) return { ok: false, error: 'No response' };
  if (json.error) return { ok: false, error: json.error.message };
  const text = extractText(json);
  if (text === undefined) return { ok: false, error: 'Empty response' };
  return { ok: true, text };
}

export async function listMcpTools(port: number): Promise<string[]> {
  const json = await mcpJsonRpc(port, 'tools/list', {});
  if (!json?.result?.tools) return [];
  return json.result.tools.map((t) => t.name);
}

export async function detectMcpServerMode(port: number): Promise<McpServerMode> {
  if (cachedMode && cachedModePort === port) return cachedMode;
  const tools = await listMcpTools(port);
  let mode: McpServerMode = 'unknown';
  if (tools.includes('call_tool') && tools.includes('list_toolsets')) {
    mode = 'tool-search';
  } else if (tools.some((t) => t === 'open_asset' || t === 'execute_command')) {
    mode = 'legacy-flat';
  }
  cachedMode = mode;
  cachedModePort = port;
  return mode;
}

export async function callToolsetTool(
  port: number,
  toolsetName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return callMcpTool(port, 'call_tool', {
    toolset_name: toolsetName,
    tool_name: toolName,
    arguments: args,
  });
}

export async function listToolsets(port: number): Promise<string[]> {
  const result = await callMcpTool(port, 'list_toolsets', {});
  if (!result.ok || !result.text) return [];
  try {
    const parsed = JSON.parse(result.text) as string[] | { toolsets?: string[] };
    if (Array.isArray(parsed)) return parsed;
    if (parsed.toolsets) return parsed.toolsets;
  } catch {
    // line-based fallback
  }
  return result.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('{'));
}

export async function describeToolset(port: number, toolsetName: string): Promise<string | undefined> {
  const result = await callMcpTool(port, 'describe_toolset', { toolset_name: toolsetName });
  return result.ok ? result.text : undefined;
}

export async function findActiveMcpPortWithMode(
  candidates: number[] = DEFAULT_MCP_PORT_CANDIDATES,
): Promise<{ port: number; mode: McpServerMode } | undefined> {
  for (const port of candidates) {
    const json = await mcpJsonRpc(port, 'tools/list', {}, 2000);
    if (json && !json.error) {
      const mode = await detectMcpServerMode(port);
      if (mode !== 'unknown') return { port, mode };
      if (json.result?.tools && json.result.tools.length > 0) return { port, mode: 'legacy-flat' };
    }
  }
  return undefined;
}

export async function resolveMcpPort(preferredPort?: number): Promise<number | undefined> {
  const candidates = preferredPort
    ? [preferredPort, ...DEFAULT_MCP_PORT_CANDIDATES.filter((p) => p !== preferredPort)]
    : DEFAULT_MCP_PORT_CANDIDATES;
  const found = await findActiveMcpPortWithMode(candidates);
  return found?.port;
}

export { EPIC_MCP_DEFAULT_PORT };
