import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_DATA_DIR, EXTENSION_DATA_DIR_LEGACY } from '../constants';

export const UHT_STUB_FILENAME = 'UHTIDEStubs.h';

export const UHT_MACRO_TOKENS = new Set([
  'UFUNCTION',
  'UPROPERTY',
  'UCLASS',
  'USTRUCT',
  'UENUM',
  'UINTERFACE',
  'GENERATED_BODY',
  'GENERATED_BODY_LEGACY',
  'GENERATED_UCLASS_BODY',
  'GENERATED_USTRUCT_BODY',
  'GENERATED_UINTERFACE_BODY',
  'GENERATED_IINTERFACE_BODY',
  'UMETA',
  'UPARAM',
  'UDELEGATE',
  'DECLARE_DYNAMIC_MULTICAST_DELEGATE',
  'DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam',
  'DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams',
  'DECLARE_MULTICAST_DELEGATE',
]);

export function isUhtStubPath(filePath: string): boolean {
  const normalized = path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
  return (
    normalized.endsWith(`/${EXTENSION_DATA_DIR}/${UHT_STUB_FILENAME}`.toLowerCase()) ||
    normalized.endsWith(`/${EXTENSION_DATA_DIR_LEGACY}/${UHT_STUB_FILENAME}`.toLowerCase()) ||
    normalized.endsWith(`/${UHT_STUB_FILENAME.toLowerCase()}`)
  );
}

export function isUhtMacroToken(word: string): boolean {
  return UHT_MACRO_TOKENS.has(word);
}

export function filterStubLocations(locations: vscode.Location[]): vscode.Location[] {
  return locations.filter((loc) => !isUhtStubPath(loc.uri.fsPath));
}

export function normalizeDefinitionLocations(
  result: vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined,
): vscode.Location[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const out: vscode.Location[] = [];
  for (const item of items) {
    if (item instanceof vscode.Location) {
      out.push(item);
      continue;
    }
    if ('targetUri' in item && item.targetUri && item.targetRange) {
      out.push(new vscode.Location(item.targetUri, item.targetRange.start));
      continue;
    }
    if ('uri' in item && item.uri && 'range' in item && item.range) {
      const link = item as vscode.LocationLink;
      const uri = link.targetUri ?? (link as { uri?: vscode.Uri }).uri;
      if (!uri) continue;
      const range = link.targetRange ?? (link as { range?: vscode.Range }).range;
      if (!range) continue;
      const start = 'start' in range ? range.start : range;
      out.push(new vscode.Location(uri, start));
    }
  }
  return out;
}
