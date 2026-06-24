import * as vscode from 'vscode';

export function themeIconIdForAssetClass(cls?: string): string {
  const c = (cls ?? '').toLowerCase();
  if (c.includes('widget')) return 'layout';
  if (c.includes('blueprint')) return 'symbol-class';
  if (c.includes('material')) return 'symbol-color';
  if (c.includes('staticmesh') || c.includes('skeletal')) return 'package';
  if (c.includes('world') || c.includes('level')) return 'globe';
  if (c.includes('niagara')) return 'sparkle';
  if (c.includes('texture')) return 'file-media';
  return 'file-media';
}

export function themeIconForAssetClass(cls?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(themeIconIdForAssetClass(cls));
}

export function emojiForAssetClass(cls?: string): string {
  const c = (cls ?? '').toLowerCase();
  if (c.includes('blueprint')) return 'BP';
  if (c.includes('material')) return 'M';
  if (c.includes('staticmesh')) return 'SM';
  if (c.includes('world')) return 'L';
  if (c.includes('widget')) return 'UI';
  return 'AS';
}
