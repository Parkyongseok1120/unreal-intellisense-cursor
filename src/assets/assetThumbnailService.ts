import type { AssetIndexEntry } from './assetIndex';
import { mcpCallLogical } from '../blueprint/mcpBlueprintBridge';
import { emojiForAssetClass } from './assetClassIcons';

export interface ParsedAssetInfo {
  packageClass?: string;
  thumbnailDataUri?: string;
}

export function parseAssetInfoResponse(text: string): ParsedAssetInfo {
  try {
    const info = JSON.parse(text) as Record<string, unknown>;
    const cls =
      (info.class as string) ??
      (info.Class as string) ??
      (info.asset_class as string) ??
      (info.AssetClass as string);

    let thumb =
      (info.thumbnail as string) ??
      (info.Thumbnail as string) ??
      (info.thumbnail_base64 as string) ??
      (info.thumbnailUrl as string) ??
      (info.thumbnail_url as string);

    if (thumb && typeof thumb === 'string') {
      if (!thumb.startsWith('data:') && !thumb.startsWith('http')) {
        thumb = `data:image/png;base64,${thumb}`;
      }
      return { packageClass: cls, thumbnailDataUri: thumb };
    }
    return { packageClass: cls };
  } catch {
    return {};
  }
}

export function offlineThumbnailBadge(entry: AssetIndexEntry): string {
  const cls = entry.packageClass ?? entry.inferredClass;
  return emojiForAssetClass(cls);
}

export async function enrichEntryWithThumbnail(entry: AssetIndexEntry): Promise<AssetIndexEntry> {
  const result = await mcpCallLogical('getAssetInfo', { assetPath: entry.assetPath });
  if (!result.ok || !result.text) return entry;

  const parsed = parseAssetInfoResponse(result.text);
  return {
    ...entry,
    packageClass: parsed.packageClass ?? entry.packageClass,
    thumbnailUri: parsed.thumbnailDataUri ?? entry.thumbnailUri,
  };
}
