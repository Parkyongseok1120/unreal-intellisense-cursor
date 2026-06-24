import * as fs from 'fs';
import * as path from 'path';
import {
  callMcpTool,
  callToolsetTool,
  describeToolset,
  detectMcpServerMode,
  listToolsets,
  type McpCallResult,
  type McpServerMode,
} from './epicMcpClient';
import { DEFAULT_MCP_PORT_CANDIDATES } from '../cursor/mcpConfig';
import { ensureDataDir } from '../platform/dataDir';
import {
  loadResolvedTools,
  resolvedToCandidate,
  resolveToolsFromEditor,
  saveResolvedTools,
} from './runtimeToolResolver';

export type LogicalToolName =
  | 'openAsset'
  | 'createBlueprint'
  | 'findBlueprintsByClass'
  | 'getBlueprintParentClass'
  | 'liveCodingCompile'
  | 'executeCommand'
  | 'findFunctionReferences'
  | 'highlightBlueprintNode'
  | 'listAssets'
  | 'getAssetInfo'
  | 'getAssetReferencers'
  | 'getAssetDependencies'
  | 'importAsset';

export interface ToolCandidate {
  toolset?: string;
  tool?: string;
  legacyFlat?: string;
  argMap?: Record<string, string>;
}

export interface McpSchemaSnapshot {
  version: string;
  engineMcpMode: string;
  defaultPort: number;
  metaTools: Record<string, string>;
  requiredPlugins: string[];
  logicalTools: Record<string, { candidates: ToolCandidate[] }>;
  toolsets: Record<string, unknown>;
  capturedAt?: string;
}

const SCHEMA_CACHE_FILE = 'mcp-schema.json';

let fallbackSchema: McpSchemaSnapshot | undefined;

function loadBundledFallback(extensionPath?: string): McpSchemaSnapshot {
  if (fallbackSchema) return fallbackSchema;
  const candidates = extensionPath
    ? [path.join(extensionPath, 'schemas', 'ue58-mcp-fallback.json')]
    : [];
  candidates.push(path.join(__dirname, '..', '..', 'schemas', 'ue58-mcp-fallback.json'));

  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      fallbackSchema = JSON.parse(raw) as McpSchemaSnapshot;
      return fallbackSchema;
    } catch {
      // try next
    }
  }

  fallbackSchema = {
    version: '5.8.0',
    engineMcpMode: 'tool-search',
    defaultPort: 8000,
    metaTools: { listToolsets: 'list_toolsets', describeToolset: 'describe_toolset', callTool: 'call_tool' },
    requiredPlugins: ['ModelContextProtocol', 'AllToolsets'],
    logicalTools: {},
    toolsets: {},
  };
  return fallbackSchema;
}

export function getFallbackSchema(extensionPath?: string): McpSchemaSnapshot {
  return loadBundledFallback(extensionPath);
}

export async function loadProjectSchema(projectRoot: string): Promise<McpSchemaSnapshot | undefined> {
  try {
    const p = path.join(projectRoot, '.ue5_8cursor', SCHEMA_CACHE_FILE);
    const raw = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(raw) as McpSchemaSnapshot;
  } catch {
    try {
      const legacy = path.join(projectRoot, '.ue58rider', SCHEMA_CACHE_FILE);
      const raw = await fs.promises.readFile(legacy, 'utf-8');
      return JSON.parse(raw) as McpSchemaSnapshot;
    } catch {
      return undefined;
    }
  }
}

export async function saveProjectSchema(projectRoot: string, schema: McpSchemaSnapshot): Promise<string> {
  const dir = await ensureDataDir(projectRoot);
  const filePath = path.join(dir, SCHEMA_CACHE_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(schema, null, 2) + '\n', 'utf-8');
  return filePath;
}

function mapArgs(logicalArgs: Record<string, unknown>, argMap?: Record<string, string>): Record<string, unknown> {
  if (!argMap || Object.keys(argMap).length === 0) return { ...logicalArgs };
  const mapped: Record<string, unknown> = {};
  for (const [logical, value] of Object.entries(logicalArgs)) {
    const targetKey = argMap[logical] ?? logical;
    mapped[targetKey] = value;
  }
  return mapped;
}

function isSuccessResult(result: McpCallResult): boolean {
  if (!result.ok || !result.text) return false;
  const lower = result.text.toLowerCase();
  if (lower.includes('error') && lower.includes('not found')) return false;
  if (lower.includes('unknown tool')) return false;
  if (lower.includes('rejected')) return false;
  return true;
}

export class SchemaRegistry {
  private schema: McpSchemaSnapshot;
  private extensionPath?: string;
  private projectRoot?: string;

  constructor(schema?: McpSchemaSnapshot, extensionPath?: string, projectRoot?: string) {
    this.schema = schema ?? loadBundledFallback(extensionPath);
    this.extensionPath = extensionPath;
    this.projectRoot = projectRoot;
  }

  static async create(projectRoot?: string, extensionPath?: string): Promise<SchemaRegistry> {
    const projectSchema = projectRoot ? await loadProjectSchema(projectRoot) : undefined;
    const schema = projectSchema ?? loadBundledFallback(extensionPath);
    return new SchemaRegistry(schema, extensionPath, projectRoot);
  }

  getSchema(): McpSchemaSnapshot {
    return this.schema;
  }

  getCandidates(logical: LogicalToolName): ToolCandidate[] {
    return this.schema.logicalTools[logical]?.candidates ?? [];
  }

  private async getResolvedCandidate(logical: LogicalToolName): Promise<ToolCandidate | undefined> {
    if (!this.projectRoot) return undefined;
    const resolved = await loadResolvedTools(this.projectRoot);
    const tool = resolved?.resolved[logical];
    return tool ? resolvedToCandidate(tool) : undefined;
  }

  async callLogical(
    logical: LogicalToolName,
    args: Record<string, unknown>,
    port: number,
    mode?: McpServerMode,
  ): Promise<McpCallResult> {
    const serverMode = mode ?? (await detectMcpServerMode(port));

    const resolved = await this.getResolvedCandidate(logical);
    if (resolved?.toolset && resolved.tool) {
      const mappedArgs = mapArgs(args, resolved.argMap);
      const result = await callToolsetTool(port, resolved.toolset, resolved.tool, mappedArgs);
      if (isSuccessResult(result)) return result;
    }

    const candidates = this.getCandidates(logical);

    for (const candidate of candidates) {
      const mappedArgs = mapArgs(args, candidate.argMap);

      if (serverMode === 'tool-search' && candidate.toolset && candidate.tool) {
        const result = await callToolsetTool(port, candidate.toolset, candidate.tool, mappedArgs);
        if (isSuccessResult(result)) return result;
      }

      if (candidate.legacyFlat && (serverMode === 'legacy-flat' || serverMode === 'unknown')) {
        const result = await callMcpTool(port, candidate.legacyFlat, mappedArgs);
        if (isSuccessResult(result)) return result;
      }
    }

    // tool-search mode: also try legacy flat as last resort
    for (const candidate of candidates) {
      if (!candidate.legacyFlat) continue;
      const mappedArgs = mapArgs(args, candidate.argMap);
      const result = await callMcpTool(port, candidate.legacyFlat, mappedArgs);
      if (isSuccessResult(result)) return result;
    }

    return { ok: false, error: `No working candidate for logical tool: ${logical}` };
  }

  async callLogicalOnAnyPort(
    logical: LogicalToolName,
    args: Record<string, unknown>,
    ports: number[] = DEFAULT_MCP_PORT_CANDIDATES,
  ): Promise<McpCallResult> {
    for (const port of ports) {
      const mode = await detectMcpServerMode(port);
      if (mode === 'unknown') continue;
      const result = await this.callLogical(logical, args, port, mode);
      if (isSuccessResult(result)) return result;
    }
    return { ok: false, error: 'MCP server not reachable' };
  }
}

export async function captureMcpSchema(
  port: number,
  extensionPath?: string,
): Promise<McpSchemaSnapshot> {
  const base = loadBundledFallback(extensionPath);
  const toolsets = await listToolsets(port);
  const toolsetDetails: Record<string, unknown> = {};

  const priority = ['AssetTools', 'BlueprintTools', 'LiveCodingToolset', 'EditorTools', 'EditorAssetTools'];
  const toDescribe = [
    ...priority.filter((t) => toolsets.includes(t)),
    ...toolsets.filter((t) => !priority.includes(t)),
  ].slice(0, 20);

  for (const ts of toDescribe) {
    const desc = await describeToolset(port, ts);
    if (desc) {
      try {
        toolsetDetails[ts] = JSON.parse(desc);
      } catch {
        toolsetDetails[ts] = { raw: desc };
      }
    }
  }

  return {
    ...base,
    capturedAt: new Date().toISOString(),
    toolsets: toolsetDetails,
  };
}

export async function refreshProjectMcpSchema(
  projectRoot: string,
  port: number,
  extensionPath?: string,
): Promise<McpSchemaSnapshot> {
  const captured = await captureMcpSchema(port, extensionPath);
  await saveProjectSchema(projectRoot, captured);
  const resolved = await resolveToolsFromEditor(port);
  await saveResolvedTools(projectRoot, resolved);
  return captured;
}
