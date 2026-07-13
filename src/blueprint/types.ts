export interface BlueprintAsset {
  assetPath: string;
  filePath?: string;
  assetName: string;
  source?: 'filesystem' | 'mcp' | 'bridge';
}

export function blueprintLabelFromEntry(entry: { assetPath: string; parentClass?: string }): string {
  return entry.assetPath.split('/').pop()?.split('.')[0] ?? entry.parentClass ?? entry.assetPath;
}
