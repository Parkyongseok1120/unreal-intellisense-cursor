import { DEFAULT_MCP_PORT_CANDIDATES } from '../cursor/mcpConfig';
import { SchemaRegistry } from '../mcp/schemaRegistry';
import type { BlueprintAsset } from './types';

export interface McpToolResult {
  ok: boolean;
  text?: string;
  error?: string;
}

let registryPromise: Promise<SchemaRegistry> | undefined;
let registryProjectRoot: string | undefined;
let registryExtensionPath: string | undefined;

export function configureMcpBridge(projectRoot?: string, extensionPath?: string): void {
  registryProjectRoot = projectRoot;
  registryExtensionPath = extensionPath;
  registryPromise = undefined;
}

async function getRegistry(): Promise<SchemaRegistry> {
  if (!registryPromise) {
    registryPromise = SchemaRegistry.create(registryProjectRoot, registryExtensionPath);
  }
  return registryPromise;
}

export async function mcpCallTool(
  toolName: string,
  args: Record<string, unknown>,
  ports: number[] = DEFAULT_MCP_PORT_CANDIDATES,
): Promise<McpToolResult> {
  const registry = await getRegistry();
  const logicalMap: Record<string, import('../mcp/schemaRegistry').LogicalToolName> = {
    open_asset: 'openAsset',
    create_blueprint: 'createBlueprint',
    find_blueprints_by_class: 'findBlueprintsByClass',
    get_blueprint_parent_class: 'getBlueprintParentClass',
    live_coding_compile: 'liveCodingCompile',
    execute_command: 'executeCommand',
    find_function_references: 'findFunctionReferences',
    find_blueprint_function_usages: 'findFunctionReferences',
    get_blueprint_nodes_for_function: 'findFunctionReferences',
    search_blueprint_nodes: 'findFunctionReferences',
    highlight_blueprint_node: 'highlightBlueprintNode',
    list_assets: 'listAssets',
    get_asset_info: 'getAssetInfo',
    get_asset_references: 'getAssetReferencers',
    get_referencers: 'getAssetReferencers',
    get_dependencies: 'getAssetDependencies',
    import_asset: 'importAsset',
  };

  const logical = logicalMap[toolName];
  if (logical) {
    return registry.callLogicalOnAnyPort(logical, args, ports);
  }

  // Unknown flat tool — try direct on each port
  const { callMcpTool: directCall } = await import('../mcp/epicMcpClient');
  for (const port of ports) {
    const result = await directCall(port, toolName, args);
    if (result.ok) return result;
  }
  return { ok: false, error: 'MCP call failed' };
}

export async function mcpCallLogical(
  logical: import('../mcp/schemaRegistry').LogicalToolName,
  args: Record<string, unknown>,
  ports: number[] = DEFAULT_MCP_PORT_CANDIDATES,
): Promise<McpToolResult> {
  const registry = await getRegistry();
  return registry.callLogicalOnAnyPort(logical, args, ports);
}

export async function mcpFindBlueprintsForClass(
  className: string,
  ports: number[] = DEFAULT_MCP_PORT_CANDIDATES,
): Promise<BlueprintAsset[]> {
  const result = await mcpCallLogical('findBlueprintsByClass', { className }, ports);
  if (!result.ok || !result.text) return [];
  return parseBlueprintList(result.text);
}

export async function mcpGetBlueprintParentClass(assetPath: string): Promise<string | undefined> {
  const result = await mcpCallLogical('getBlueprintParentClass', { assetPath }, DEFAULT_MCP_PORT_CANDIDATES);
  return result.ok && result.text ? result.text.trim() : undefined;
}

export function parseBlueprintList(text: string): BlueprintAsset[] {
  try {
    const parsed = JSON.parse(text) as Array<Record<string, string>>;
    if (Array.isArray(parsed)) {
      return parsed.map((p) => ({
        assetPath: p.assetPath ?? p.path ?? p.name ?? '',
        assetName: p.assetName ?? (p.assetPath ?? p.path ?? '').split('/').pop()?.split('.')[0] ?? '',
        filePath: p.filePath ?? '',
      })).filter((p) => p.assetPath.includes('/Game/'));
    }
  } catch {
    // line-based fallback
  }

  return text
    .split('\n')
    .filter((l) => l.includes('/Game/'))
    .map((l) => {
      const assetPath = l.trim().split(/\s+/)[0];
      const assetName = assetPath.split('/').pop()?.split('.')[0] ?? '';
      return { assetPath, assetName, filePath: '' };
    });
}
