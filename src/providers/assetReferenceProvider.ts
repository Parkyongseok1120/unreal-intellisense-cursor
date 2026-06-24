import * as vscode from 'vscode';
import { findAssetPathsInLine } from '../assets/assetPathParser';
import { getAssetReferencers, findSourceUsages } from '../assets/assetReferenceService';

export class AssetReferenceProvider implements vscode.ReferenceProvider {
  constructor(private projectRoot: () => string | undefined) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const root = this.projectRoot();
    if (!root) return undefined;

    const line = document.lineAt(position.line).text;
    const matches = findAssetPathsInLine(line, position.line);
    const hit = matches.find((m) => position.character >= m.start && position.character <= m.end);
    if (!hit) return undefined;

    const locations: vscode.Location[] = [];

    const sourceUsages = await findSourceUsages(root, hit.assetPath);
    for (const usage of sourceUsages) {
      if (!usage.sourceFile) continue;
      const lineNum = Math.max(0, (usage.sourceLine ?? 1) - 1);
      locations.push(
        new vscode.Location(
          vscode.Uri.file(usage.sourceFile),
          new vscode.Range(lineNum, 0, lineNum, 0),
        ),
      );
    }

    const referencers = await getAssetReferencers(hit.assetPath);
    for (const ref of referencers) {
      const entries = await import('../assets/assetIndex').then((m) => m.getOrBuildAssetIndex(root));
      const entry = entries.find((e) => e.assetPath.toLowerCase() === ref.assetPath.toLowerCase());
      if (entry) {
        locations.push(new vscode.Location(vscode.Uri.file(entry.diskPath), new vscode.Position(0, 0)));
      }
    }

    return locations.length > 0 ? locations : undefined;
  }
}
