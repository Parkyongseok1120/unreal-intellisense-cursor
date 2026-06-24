import type { BlueprintAsset } from './types';

const TTL_MS = 60_000;

interface CacheEntry {
  expires: number;
  assets: BlueprintAsset[];
}

const cache = new Map<string, CacheEntry>();

function cacheKey(projectRoot: string, className: string): string {
  return `${projectRoot.toLowerCase()}::${className}`;
}

export function getCachedBlueprints(projectRoot: string, className: string): BlueprintAsset[] | undefined {
  const entry = cache.get(cacheKey(projectRoot, className));
  if (!entry || Date.now() > entry.expires) {
    if (entry) cache.delete(cacheKey(projectRoot, className));
    return undefined;
  }
  return entry.assets;
}

export function setCachedBlueprints(projectRoot: string, className: string, assets: BlueprintAsset[]): void {
  cache.set(cacheKey(projectRoot, className), { expires: Date.now() + TTL_MS, assets });
}

export function invalidateBlueprintCache(projectRoot?: string): void {
  if (!projectRoot) {
    cache.clear();
    return;
  }
  const prefix = projectRoot.toLowerCase() + '::';
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
