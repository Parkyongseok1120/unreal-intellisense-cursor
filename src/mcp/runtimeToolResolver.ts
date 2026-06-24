import * as fs from 'fs';
import * as path from 'path';
import { describeToolset, listToolsets } from './epicMcpClient';
import type { LogicalToolName } from './schemaRegistry';
import type { ToolCandidate } from './schemaRegistry';
import { ensureDataDir } from '../platform/dataDir';

export interface ResolvedTool {
  toolset: string;
  tool: string;
  argMap?: Record<string, string>;
}

export interface ResolvedToolsCache {
  version: number;
  capturedAt: string;
  port: number;
  resolved: Partial<Record<LogicalToolName, ResolvedTool>>;
  failed: LogicalToolName[];
}

const CACHE_VERSION = 1;
const CACHE_FILE = 'mcp-resolved-tools.json';

const LOGICAL_KEYWORDS: Record<LogicalToolName, string[][]> = {
  openAsset: [['open'], ['asset']],
  createBlueprint: [['create'], ['blueprint']],
  findBlueprintsByClass: [['blueprint'], ['class', 'parent', 'find']],
  getBlueprintParentClass: [['parent'], ['blueprint', 'class']],
  liveCodingCompile: [['live'], ['coding', 'compile']],
  executeCommand: [['console', 'command'], ['execute']],
  findFunctionReferences: [['function'], ['reference', 'usage', 'node']],
  highlightBlueprintNode: [['highlight'], ['node']],
  listAssets: [['list'], ['asset']],
  getAssetInfo: [['info', 'describe'], ['asset']],
  getAssetReferencers: [['referencer', 'reference'], ['asset']],
  getAssetDependencies: [['dependenc'], ['asset']],
  importAsset: [['import'], ['asset']],
};

function scoreToolName(name: string, keywords: string[][]): number {
  const lower = name.toLowerCase();
  let score = 0;
  for (const group of keywords) {
    if (group.some((k) => lower.includes(k))) score += 10;
  }
  return score;
}

function parseToolsetTools(describeText: string): Array<{ name: string; description?: string }> {
  try {
    const json = JSON.parse(describeText) as {
      tools?: Array<{ name: string; description?: string }>;
    };
    if (json.tools) return json.tools;
  } catch {
    // fall through
  }

  const tools: Array<{ name: string; description?: string }> = [];
  for (const line of describeText.split('\n')) {
    const m = line.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (m) tools.push({ name: m[1] });
  }
  return tools;
}

export function resolveToolFromCatalog(
  logical: LogicalToolName,
  toolsetName: string,
  tools: Array<{ name: string; description?: string }>,
): ResolvedTool | undefined {
  const keywords = LOGICAL_KEYWORDS[logical];
  let best: { name: string; score: number } | undefined;

  for (const tool of tools) {
    const text = `${tool.name} ${tool.description ?? ''}`;
    const score = scoreToolName(text, keywords);
    if (!best || score > best.score) {
      best = { name: tool.name, score };
    }
  }

  if (!best || best.score < 10) return undefined;

  return {
    toolset: toolsetName,
    tool: best.name,
    argMap: defaultArgMap(logical),
  };
}

function defaultArgMap(logical: LogicalToolName): Record<string, string> | undefined {
  const maps: Partial<Record<LogicalToolName, Record<string, string>>> = {
    openAsset: { path: 'asset_path' },
    getAssetInfo: { assetPath: 'asset_path' },
    getAssetReferencers: { assetPath: 'asset_path' },
    getAssetDependencies: { assetPath: 'asset_path' },
    getBlueprintParentClass: { assetPath: 'asset_path' },
    findBlueprintsByClass: { className: 'class_name' },
    findFunctionReferences: { className: 'class_name', functionName: 'function_name' },
    highlightBlueprintNode: { assetPath: 'asset_path', functionName: 'node_name' },
    executeCommand: { command: 'command' },
    createBlueprint: { parentClass: 'parent_class', name: 'name' },
    importAsset: { sourcePath: 'source_path', destPath: 'dest_path', assetPath: 'asset_path' },
  };
  return maps[logical];
}

export async function resolveToolsFromEditor(port: number): Promise<ResolvedToolsCache> {
  const toolsets = await listToolsets(port);
  const resolved: Partial<Record<LogicalToolName, ResolvedTool>> = {};
  const failed: LogicalToolName[] = [];

  const priorityToolsets = [
    'AssetTools',
    'BlueprintTools',
    'LiveCodingToolset',
    'EditorTools',
    ...toolsets,
  ];
  const seen = new Set<string>();
  const ordered = priorityToolsets.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return toolsets.includes(t) || ['AssetTools', 'BlueprintTools', 'LiveCodingToolset', 'EditorTools'].includes(t);
  });

  const catalog: Array<{ toolset: string; tools: Array<{ name: string; description?: string }> }> = [];
  for (const ts of ordered) {
    const desc = await describeToolset(port, ts);
    if (!desc) continue;
    catalog.push({ toolset: ts, tools: parseToolsetTools(desc) });
  }

  const logicalNames = Object.keys(LOGICAL_KEYWORDS) as LogicalToolName[];
  for (const logical of logicalNames) {
    let best: ResolvedTool | undefined;
    let bestScore = 0;

    for (const { toolset, tools } of catalog) {
      const candidate = resolveToolFromCatalog(logical, toolset, tools);
      if (!candidate) continue;
      const score = scoreToolName(`${candidate.toolset}.${candidate.tool}`, LOGICAL_KEYWORDS[logical]);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (best) resolved[logical] = best;
    else failed.push(logical);
  }

  return {
    version: CACHE_VERSION,
    capturedAt: new Date().toISOString(),
    port,
    resolved,
    failed,
  };
}

export async function saveResolvedTools(projectRoot: string, cache: ResolvedToolsCache): Promise<string> {
  const dir = await ensureDataDir(projectRoot);
  const filePath = path.join(dir, CACHE_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function loadResolvedTools(projectRoot: string): Promise<ResolvedToolsCache | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, CACHE_FILE), 'utf-8');
      return JSON.parse(raw) as ResolvedToolsCache;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function resolvedToCandidate(resolved: ResolvedTool): ToolCandidate {
  return {
    toolset: resolved.toolset,
    tool: resolved.tool,
    argMap: resolved.argMap,
  };
}
