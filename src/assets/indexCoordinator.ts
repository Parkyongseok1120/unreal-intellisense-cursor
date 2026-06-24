import { invalidateBlueprintCache } from '../blueprint/blueprintCache';
import { refreshAssetIndex, loadAssetIndexCache } from './assetIndex';
import { refreshReflectionIndex } from '../uht/reflectionIndex';

export interface IndexRefreshResult {
  assetCount: number;
  reflectionClassCount: number;
}

export async function refreshAllIndexes(
  projectRoot: string,
  options: { enrichMcp?: boolean; skipReflection?: boolean } = {},
): Promise<IndexRefreshResult> {
  invalidateBlueprintCache(projectRoot);

  const entries = await refreshAssetIndex(projectRoot, { enrichMcp: options.enrichMcp ?? false });
  let reflectionClassCount = 0;

  if (!options.skipReflection) {
    const classes = await refreshReflectionIndex(projectRoot);
    reflectionClassCount = classes.length;
  }

  return { assetCount: entries.length, reflectionClassCount };
}

export async function getIndexCounts(projectRoot: string): Promise<{ assets: number; reflection: number }> {
  const assetCache = await loadAssetIndexCache(projectRoot);
  let reflection = 0;
  try {
    const { loadReflectionIndex } = await import('../uht/reflectionIndex');
    reflection = (await loadReflectionIndex(projectRoot)).length;
  } catch {
    // ignore
  }
  return {
    assets: assetCache?.entries.length ?? 0,
    reflection,
  };
}
