import * as fs from 'fs';
import * as path from 'path';
import { ensureDataDir } from '../platform/dataDir';
import { probeMcpEndpoint } from '../cursor/mcpConfig';

export interface AssetIndexEntry {
  diskPath: string;
  assetPath: string;
  fileName: string;
  assetName: string;
  inferredClass?: string;
  packageClass?: string;
  thumbnailUri?: string;
  mtimeMs?: number;
  source?: 'content-scan' | 'bridge' | 'mcp';
  confidence?: 'authoritative' | 'derived' | 'heuristic';
}

export interface AssetPageResult {
  entries: AssetIndexEntry[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export function getAssetPage(entries: AssetIndexEntry[], offset = 0, limit = 500): AssetPageResult {
  const total = entries.length;
  const slice = entries.slice(offset, offset + limit);
  return {
    entries: slice,
    total,
    offset,
    hasMore: offset + slice.length < total,
  };
}

export interface AssetIndexCache {
  version: number;
  updatedAt: string;
  contentScanMtime?: number;
  entries: AssetIndexEntry[];
}

const CACHE_VERSION = 2;
const CACHE_FILE = 'asset-index.json';
const ASSET_EXTENSIONS = ['.uasset', '.umap'];
const MCP_ENRICH_BATCH = 20;
const MCP_ENRICH_DELAY_MS = 50;

export function contentToAssetPath(contentRelative: string, assetName: string): string {
  const withoutExt = contentRelative.replace(/\\/g, '/').replace(/\.(uasset|umap)$/i, '');
  const gamePath = withoutExt.startsWith('Content/')
    ? withoutExt.slice('Content/'.length)
    : withoutExt;
  return `/Game/${gamePath}.${assetName}`;
}

export function inferClassFromName(assetName: string): string | undefined {
  if (/^BP_/i.test(assetName)) return 'Blueprint';
  if (/^WBP_/i.test(assetName)) return 'WidgetBlueprint';
  if (/^ABP_/i.test(assetName)) return 'AnimBlueprint';
  if (/^BPI_/i.test(assetName)) return 'BlueprintInterface';
  if (/^M_/i.test(assetName)) return 'Material';
  if (/^MI_/i.test(assetName)) return 'MaterialInstance';
  if (/^SM_/i.test(assetName)) return 'StaticMesh';
  if (/^SK_/i.test(assetName)) return 'SkeletalMesh';
  if (/^NS_/i.test(assetName)) return 'NiagaraSystem';
  if (/^L_/i.test(assetName) || /\.umap$/i.test(assetName)) return 'World';
  return undefined;
}

function isAssetFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function assetNameFromPath(filePath: string): string {
  const base = path.basename(filePath);
  for (const ext of ASSET_EXTENSIONS) {
    if (base.toLowerCase().endsWith(ext)) return base.slice(0, -ext.length);
  }
  return path.basename(filePath, path.extname(filePath));
}

export async function findUassetsRecursive(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth <= 0) return;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && isAssetFile(entry.name)) {
        results.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await findUassetsRecursive(full, depth - 1, results);
      }
    }
  } catch {
    // Content may not exist
  }
}

function entryFromFile(contentDir: string, filePath: string, mtimeMs: number): AssetIndexEntry {
  const assetName = assetNameFromPath(filePath);
  const relFromContent = path.relative(contentDir, filePath);
  return {
    diskPath: filePath,
    assetPath: contentToAssetPath(path.join('Content', relFromContent), assetName),
    fileName: path.basename(filePath),
    assetName,
    inferredClass: inferClassFromName(assetName),
    mtimeMs,
    source: 'content-scan',
    confidence: 'derived',
  };
}

async function entryFromFileEnriched(contentDir: string, filePath: string, mtimeMs: number): Promise<AssetIndexEntry> {
  const base = entryFromFile(contentDir, filePath, mtimeMs);
  const { enrichEntryFromUasset } = await import('./uassetReader');
  const enriched = await enrichEntryFromUasset(filePath, base.assetName, base.inferredClass);
  return {
    ...base,
    packageClass: enriched.packageClass ?? base.inferredClass,
    assetPath: enriched.assetPath ?? base.assetPath,
  };
}

export async function buildAssetIndex(projectRoot: string, maxDepth = 16): Promise<AssetIndexEntry[]> {
  const contentDirs = [path.join(projectRoot, 'Content')];
  const pluginsDir = path.join(projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const plugin of plugins) {
      if (plugin.isDirectory()) {
        contentDirs.push(path.join(pluginsDir, plugin.name, 'Content'));
      }
    }
  } catch {
    // no plugins
  }

  const allFiles: string[] = [];
  for (const contentDir of contentDirs) {
    await findUassetsRecursive(contentDir, maxDepth, allFiles);
  }

  const entries: AssetIndexEntry[] = [];
  for (const filePath of allFiles) {
    const contentDir = contentDirs.find((d) => filePath.startsWith(d)) ?? path.join(projectRoot, 'Content');
    try {
      const stat = await fs.promises.stat(filePath);
      entries.push(await entryFromFileEnriched(contentDir, filePath, stat.mtimeMs));
    } catch {
      entries.push(await entryFromFileEnriched(contentDir, filePath, 0));
    }
  }

  return entries.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
}

async function getContentDirMtime(contentDir: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(contentDir);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

export async function loadAssetIndexCache(projectRoot: string): Promise<AssetIndexCache | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, CACHE_FILE), 'utf-8');
      return JSON.parse(raw) as AssetIndexCache;
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function saveAssetIndex(projectRoot: string, entries: AssetIndexEntry[]): Promise<string> {
  const dir = await ensureDataDir(projectRoot);
  const contentDir = path.join(projectRoot, 'Content');
  const cache: AssetIndexCache = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    contentScanMtime: await getContentDirMtime(contentDir),
    entries,
  };
  const filePath = path.join(dir, CACHE_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function loadAssetIndex(projectRoot: string): Promise<AssetIndexEntry[]> {
  const cache = await loadAssetIndexCache(projectRoot);
  return cache?.entries ?? [];
}

async function incrementalRefresh(projectRoot: string, existing: AssetIndexCache): Promise<AssetIndexEntry[]> {
  const contentDirs = [path.join(projectRoot, 'Content')];
  const pluginsDir = path.join(projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const plugin of plugins) {
      if (plugin.isDirectory()) {
        contentDirs.push(path.join(pluginsDir, plugin.name, 'Content'));
      }
    }
  } catch {
    // no plugins
  }

  const byDisk = new Map(existing.entries.map((e) => [e.diskPath.toLowerCase(), e]));
  const seen = new Set<string>();

  for (const contentDir of contentDirs) {
    const allFiles: string[] = [];
    await findUassetsRecursive(contentDir, 16, allFiles);
    for (const filePath of allFiles) {
      seen.add(filePath.toLowerCase());
      try {
        const stat = await fs.promises.stat(filePath);
        const prev = byDisk.get(filePath.toLowerCase());
        if (prev && prev.mtimeMs === stat.mtimeMs) {
          continue;
        }
        byDisk.set(filePath.toLowerCase(), await entryFromFileEnriched(contentDir, filePath, stat.mtimeMs));
      } catch {
        byDisk.set(filePath.toLowerCase(), await entryFromFileEnriched(contentDir, filePath, 0));
      }
    }
  }

  for (const key of byDisk.keys()) {
    if (!seen.has(key)) byDisk.delete(key);
  }

  return [...byDisk.values()].sort((a, b) => a.assetPath.localeCompare(b.assetPath));
}

export async function applyBridgeAssetDelta(
  projectRoot: string,
  delta: { added: Array<{ assetPath: string; className?: string }>; removed: string[]; updated: Array<{ assetPath: string; className?: string }> },
): Promise<AssetIndexEntry[]> {
  const entries = await loadAssetIndex(projectRoot);
  const byPath = new Map(entries.map((e) => [e.assetPath.toLowerCase(), e]));

  for (const removed of delta.removed) {
    byPath.delete(removed.toLowerCase());
  }

  const upsert = (asset: { assetPath: string; className?: string }) => {
    const key = asset.assetPath.toLowerCase();
    const name = asset.assetPath.split('/').pop()?.split('.')[0] ?? 'Asset';
    const existing = byPath.get(key);
    if (existing) {
      existing.packageClass = asset.className ?? existing.packageClass;
      existing.source = 'bridge';
      existing.confidence = 'authoritative';
      return;
    }
    byPath.set(key, {
      diskPath: '',
      assetPath: asset.assetPath,
      fileName: name,
      assetName: name,
      packageClass: asset.className,
      inferredClass: asset.className ?? inferClassFromName(name),
      source: 'bridge',
      confidence: 'authoritative',
    });
  };

  for (const asset of delta.added) upsert(asset);
  for (const asset of delta.updated) upsert(asset);

  const merged = [...byPath.values()].sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  await saveAssetIndex(projectRoot, merged);
  return merged;
}

export async function enrichAssetFromMcp(entry: AssetIndexEntry): Promise<AssetIndexEntry> {
  const { enrichEntryWithThumbnail } = await import('./assetThumbnailService');
  return enrichEntryWithThumbnail(entry);
}

async function enrichBatch(entries: AssetIndexEntry[]): Promise<AssetIndexEntry[]> {
  const mcpUp = await probeMcpEndpoint(8000, 500);
  if (!mcpUp) return entries;

  const result: AssetIndexEntry[] = [];
  for (let i = 0; i < entries.length; i += MCP_ENRICH_BATCH) {
    const batch = entries.slice(i, i + MCP_ENRICH_BATCH);
    for (const entry of batch) {
      result.push(await enrichAssetFromMcp(entry));
    }
    if (i + MCP_ENRICH_BATCH < entries.length) {
      await new Promise((r) => setTimeout(r, MCP_ENRICH_DELAY_MS));
    }
  }
  return result;
}

export async function mergeBridgeAssets(
  entries: AssetIndexEntry[],
  bridgeAssets: Array<{ assetPath: string; className?: string }>,
): Promise<AssetIndexEntry[]> {
  if (bridgeAssets.length === 0) return entries;
  const byPath = new Map(entries.map((e) => [e.assetPath.toLowerCase(), e]));
  for (const asset of bridgeAssets) {
    const key = asset.assetPath.toLowerCase();
    const existing = byPath.get(key);
    if (existing) {
      existing.packageClass = asset.className ?? existing.packageClass;
    } else {
      const name = asset.assetPath.split('/').pop()?.split('.')[0] ?? 'Asset';
      const entry: AssetIndexEntry = {
        diskPath: '',
        assetPath: asset.assetPath,
        fileName: name,
        assetName: name,
        packageClass: asset.className,
        inferredClass: asset.className,
      };
      entries.push(entry);
      byPath.set(key, entry);
    }
  }
  return entries;
}

export async function refreshAssetIndex(
  projectRoot: string,
  options: { enrichMcp?: boolean; forceFull?: boolean; bridgeAssets?: Array<{ assetPath: string; className?: string }> } = {},
): Promise<AssetIndexEntry[]> {
  const existing = await loadAssetIndexCache(projectRoot);
  let entries: AssetIndexEntry[];

  if (!options.forceFull && existing && existing.version >= CACHE_VERSION && existing.entries.length > 0) {
    entries = await incrementalRefresh(projectRoot, existing);
  } else {
    entries = await buildAssetIndex(projectRoot);
  }

  if (options.enrichMcp) {
    entries = await enrichBatch(entries);
  }

  if (options.bridgeAssets?.length) {
    entries = await mergeBridgeAssets(entries, options.bridgeAssets);
  }

  await saveAssetIndex(projectRoot, entries);
  return entries;
}

export async function getOrBuildAssetIndex(projectRoot: string): Promise<AssetIndexEntry[]> {
  const cached = await loadAssetIndex(projectRoot);
  if (cached.length > 0) return cached;
  return refreshAssetIndex(projectRoot);
}

export function findAssetByPath(entries: AssetIndexEntry[], assetPath: string): AssetIndexEntry | undefined {
  const norm = assetPath.replace(/\\/g, '/').toLowerCase();
  return entries.find((e) => e.assetPath.toLowerCase() === norm);
}

export function filterAssetsByClass(entries: AssetIndexEntry[], classFilter?: string): AssetIndexEntry[] {
  if (!classFilter || classFilter === 'All') return entries;
  const f = classFilter.toLowerCase();
  return entries.filter((e) => {
    const cls = (e.packageClass ?? e.inferredClass ?? '').toLowerCase();
    return cls.includes(f) || e.assetName.toLowerCase().startsWith(f.slice(0, 2));
  });
}

export function searchAssets(entries: AssetIndexEntry[], query: string): AssetIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.assetName.toLowerCase().includes(q) ||
      e.assetPath.toLowerCase().includes(q) ||
      (e.packageClass ?? e.inferredClass ?? '').toLowerCase().includes(q),
  );
}
