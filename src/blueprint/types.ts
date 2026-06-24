export interface BlueprintAsset {
  assetPath: string;
  filePath: string;
  assetName: string;
  source?: 'filesystem' | 'mcp';
}
