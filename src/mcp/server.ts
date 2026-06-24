import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EPIC_MCP_DEFAULT_PORT, DEFAULT_MCP_PORT_CANDIDATES } from '../cursor/mcpConfig';

const UE_MCP_PORTS = DEFAULT_MCP_PORT_CANDIDATES;
const COMMAND_MAP: Record<string, string> = {
  ue_build: 'ue58rider.build',
  ue_live_coding: 'ue58rider.liveCoding',
  ue_refresh_intellisense: 'ue58rider.generateCompileCommands',
};

interface ToolCallPayload {
  toolset_name: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

async function callUeMcpViaCallTool(payload: ToolCallPayload): Promise<string> {
  for (const port of UE_MCP_PORTS) {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: payload,
        },
      });
      const result = await httpPost(`http://127.0.0.1:${port}/mcp`, body);
      if (result && !result.includes('not reachable')) return result;
    } catch {
      // try next port
    }
  }
  return 'UE MCP server not reachable. Start Unreal Editor with MCP plugin enabled.';
}

async function callUeMcpLegacy(toolName: string, args: Record<string, unknown>): Promise<string> {
  for (const port of UE_MCP_PORTS) {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
      const result = await httpPost(`http://127.0.0.1:${port}/mcp`, body);
      if (result) return result;
    } catch {
      // try next port
    }
  }
  return 'UE MCP server not reachable. Start Unreal Editor with MCP plugin enabled.';
}

async function openAsset(assetPath: string): Promise<string> {
  const epic = await callUeMcpViaCallTool({
    toolset_name: 'AssetTools',
    tool_name: 'open_asset',
    arguments: { asset_path: assetPath },
  });
  if (!epic.includes('not reachable') && !epic.includes('error')) return epic;
  return callUeMcpLegacy('open_asset', { path: assetPath });
}

async function callExtensionBridge(command: string, args: unknown[] = []): Promise<string> {
  const workspace = process.env.UE5_8_CURSOR_WORKSPACE;
  if (!workspace) return 'UE5_8_CURSOR_WORKSPACE not set';

  let port: number | undefined;
  const bridgePaths = [
    path.join(workspace, '.ue5_8cursor', 'command-bridge.json'),
    path.join(workspace, '.ue58rider', 'command-bridge.json'),
  ];
  for (const p of bridgePaths) {
    try {
      const info = JSON.parse(await fs.promises.readFile(p, 'utf-8')) as { port: number };
      port = info.port;
      break;
    } catch {
      // try next
    }
  }
  if (!port) return 'Extension command bridge not running. Open project in Cursor with UE5_8 Cursor active.';

  const body = JSON.stringify({ command, args });
  return httpPost(`http://127.0.0.1:${port}/command`, body);
}

function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = new Server({ name: 'ue5-8-cursor', version: '4.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'ue_build', description: 'Build UE project via UE5_8 Cursor', inputSchema: { type: 'object', properties: {} } },
    { name: 'ue_live_coding', description: 'Trigger Live Coding compile', inputSchema: { type: 'object', properties: {} } },
    { name: 'ue_refresh_intellisense', description: 'Regenerate compile_commands.json', inputSchema: { type: 'object', properties: {} } },
    { name: 'ue_open_blueprint', description: 'Open Blueprint asset in editor', inputSchema: { type: 'object', properties: { assetPath: { type: 'string' } }, required: ['assetPath'] } },
    { name: 'ue_editor_command', description: 'Proxy command to UE 5.8 native MCP if available', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'ue_refresh_mcp_schema', description: 'Refresh MCP toolset schema snapshot', inputSchema: { type: 'object', properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  let text: string;
  switch (name) {
    case 'ue_open_blueprint':
      text = await openAsset(args.assetPath as string);
      break;
    case 'ue_editor_command':
      text = await callUeMcpViaCallTool({
        toolset_name: 'EditorTools',
        tool_name: 'execute_console_command',
        arguments: { command: args.command },
      });
      if (text.includes('not reachable') || text.includes('error')) {
        text = await callUeMcpLegacy('execute_command', { command: args.command });
      }
      break;
    case 'ue_refresh_mcp_schema':
      text = await callExtensionBridge('ue58rider.refreshMcpSchema');
      break;
    default: {
      const vscodeCommand = COMMAND_MAP[name];
      if (vscodeCommand) {
        text = await callExtensionBridge(vscodeCommand);
      } else {
        text = `Unknown tool: ${name}`;
      }
    }
  }

  return { content: [{ type: 'text', text }] };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

export { EPIC_MCP_DEFAULT_PORT };
