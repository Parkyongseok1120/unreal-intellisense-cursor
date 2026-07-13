import * as fs from 'fs';
import * as path from 'path';
import { mcpCallLogical } from '../blueprint/mcpBlueprintBridge';
import { findAssetPathsInDocument } from './assetPathParser';
import { loadAssetIndex, type AssetIndexEntry } from './assetIndex';
import type { EditorBridgeClient } from '../editorBridge/editorBridgeClient';

export interface AssetReference {
  assetPath: string;
  assetName: string;
  assetClass?: string;
  direction: 'referencer' | 'dependency' | 'source-usage';
  sourceFile?: string;
  sourceLine?: number;
  authoritative?: boolean;
}

export interface AssetReferenceBridge {
  getAssetReferencersResult?(
    assetPath: string,
    depth?: number,
  ): Promise<import('../editorBridge/bridgeResult').BridgeResult<Array<{ assetPath: string; className?: string }>>>;
  getAssetReferencers(assetPath: string, depth?: number): Promise<Array<{ assetPath: string; className?: string }>>;
  getAssetDependencies(assetPath: string): Promise<Array<{ assetPath: string; className?: string }>>;
  isConnected(): boolean;
}

function parseAssetList(text: string): Array<{ assetPath: string; assetName: string; assetClass?: string }> {
  try {
    const json = JSON.parse(text) as Array<Record<string, string>>;
    if (Array.isArray(json)) {
      return json.map((item) => {
        const assetPath = item.assetPath ?? item.path ?? item.name ?? '';
        return {
          assetPath,
          assetName: item.assetName ?? assetPath.split('/').pop()?.split('.')[0] ?? '',
          assetClass: item.class ?? item.Class,
        };
      }).filter((a) => a.assetPath.length > 0);
    }
  } catch {
    // line fallback
  }

  return text
    .split('\n')
    .filter((l) => l.includes('/Game/'))
    .map((l) => {
      const assetPath = l.trim().split(/\s+/)[0];
      return {
        assetPath,
        assetName: assetPath.split('/').pop()?.split('.')[0] ?? '',
      };
    });
}

export async function getAssetReferencers(
  assetPath: string,
  depth = 1,
  bridge?: AssetReferenceBridge,
): Promise<AssetReference[]> {
  if (bridge?.isConnected()) {
    const client = bridge as import('../editorBridge/editorBridgeClient').EditorBridgeClient;
    if (typeof client.getAssetReferencersResult === 'function') {
      const result = await client.getAssetReferencersResult(assetPath, depth);
      if (result.ok) {
        return result.value.map((a) => ({
          assetPath: a.assetPath,
          assetName: a.assetPath.split('/').pop()?.split('.')[0] ?? '',
          assetClass: a.className,
          direction: 'referencer' as const,
          authoritative: true,
        }));
      }
    } else {
      try {
        const refs = await bridge.getAssetReferencers(assetPath, depth);
        return refs.map((a) => ({
          assetPath: a.assetPath,
          assetName: a.assetPath.split('/').pop()?.split('.')[0] ?? '',
          assetClass: a.className,
          direction: 'referencer' as const,
          authoritative: true,
        }));
      } catch {
        // fall through to MCP
      }
    }
  }

  const seen = new Set<string>();
  const results: AssetReference[] = [];

  async function collect(path: string, remaining: number): Promise<void> {
    const norm = path.toLowerCase();
    if (seen.has(norm) || remaining <= 0) return;
    seen.add(norm);

    const result = await mcpCallLogical('getAssetReferencers', { assetPath: path });
    if (!result.ok || !result.text) return;

    for (const a of parseAssetList(result.text)) {
      const key = a.assetPath.toLowerCase();
      if (seen.has(key)) continue;
      results.push({ ...a, direction: 'referencer' });
      if (remaining > 1) {
        await collect(a.assetPath, remaining - 1);
      }
    }
  }

  await collect(assetPath, depth);
  return results;
}

export async function getAssetDependencies(
  assetPath: string,
  bridge?: AssetReferenceBridge,
): Promise<AssetReference[]> {
  if (bridge?.isConnected()) {
    try {
      const deps = await bridge.getAssetDependencies(assetPath);
      return deps.map((a) => ({
        assetPath: a.assetPath,
        assetName: a.assetPath.split('/').pop()?.split('.')[0] ?? '',
        assetClass: a.className,
        direction: 'dependency' as const,
        authoritative: true,
      }));
    } catch {
      // fall through to MCP
    }
  }

  const result = await mcpCallLogical('getAssetDependencies', { assetPath });
  if (!result.ok || !result.text) return [];
  return parseAssetList(result.text).map((a) => ({
    ...a,
    direction: 'dependency' as const,
  }));
}

export async function findSourceUsages(projectRoot: string, assetPath: string): Promise<AssetReference[]> {
  const results: AssetReference[] = [];
  const norm = assetPath.toLowerCase();
  const shortName = assetPath.split('/').pop()?.split('.')[0]?.toLowerCase() ?? '';

  async function scanDir(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.cpp') || entry.name.endsWith('.h'))) {
        try {
          const text = await fs.promises.readFile(full, 'utf-8');
          if (!text.toLowerCase().includes(shortName) && !text.toLowerCase().includes(norm)) continue;
          const matches = findAssetPathsInDocument(text);
          for (const m of matches) {
            if (m.assetPath.toLowerCase() === norm || m.assetPath.toLowerCase().includes(shortName)) {
              results.push({
                assetPath: m.assetPath,
                assetName: m.assetPath.split('/').pop()?.split('.')[0] ?? '',
                direction: 'source-usage',
                sourceFile: full,
                sourceLine: m.line + 1,
              });
            }
          }
        } catch {
          // skip
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await scanDir(full, depth - 1);
      }
    }
  }

  await scanDir(path.join(projectRoot, 'Source'), 12);
  const pluginsDir = path.join(projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const p of plugins) {
      if (p.isDirectory()) await scanDir(path.join(pluginsDir, p.name, 'Source'), 8);
    }
  } catch {
    // no plugins
  }

  return results;
}

export async function buildReferenceGraph(
  projectRoot: string,
  centerAssetPath: string,
  bridge?: AssetReferenceBridge,
): Promise<{
  center: string;
  referencers: AssetReference[];
  dependencies: AssetReference[];
  sourceUsages: AssetReference[];
  editorConnected: boolean;
}> {
  let editorConnected = bridge?.isConnected() ?? false;
  if (!editorConnected) {
    const { probeMcpEndpoint } = await import('../cursor/mcpConfig');
    editorConnected = await probeMcpEndpoint(8000, 500);
  }

  const [referencers, dependencies, sourceUsages] = await Promise.all([
    getAssetReferencers(centerAssetPath, 2, bridge),
    getAssetDependencies(centerAssetPath, bridge),
    findSourceUsages(projectRoot, centerAssetPath),
  ]);

  return { center: centerAssetPath, referencers, dependencies, sourceUsages, editorConnected };
}

export async function resolveAssetPathToEntry(
  projectRoot: string,
  assetPath: string,
): Promise<AssetIndexEntry | undefined> {
  const entries = await loadAssetIndex(projectRoot);
  const norm = assetPath.toLowerCase();
  return entries.find((e) => e.assetPath.toLowerCase() === norm);
}
