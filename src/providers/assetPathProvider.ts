import * as vscode from 'vscode';
import { findAssetPathsInLine } from '../assets/assetPathParser';
import { getOrBuildAssetIndex, findAssetByPath } from '../assets/assetIndex';

export class AssetPathDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      for (const match of findAssetPathsInLine(line, i)) {
        links.push(
          new vscode.DocumentLink(
            new vscode.Range(i, match.start, i, match.end),
            vscode.Uri.parse(`ue58rider://asset/${encodeURIComponent(match.assetPath)}`),
          ),
        );
      }
    }
    return links;
  }
}

export class AssetPathDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private projectRoot: (uri?: vscode.Uri) => string | undefined) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location | vscode.Location[] | undefined> {
    const root = this.projectRoot(document.uri);
    if (!root) return undefined;

    const line = document.lineAt(position.line).text;
    const matches = findAssetPathsInLine(line, position.line);
    const hit = matches.find((m) => position.character >= m.start && position.character <= m.end);
    if (!hit) return undefined;

    const entries = await getOrBuildAssetIndex(root);
    const entry = findAssetByPath(entries, hit.assetPath);
    if (!entry) return undefined;

    return new vscode.Location(vscode.Uri.file(entry.diskPath), new vscode.Position(0, 0));
  }
}

export class AssetPathCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      for (const match of findAssetPathsInLine(line, i)) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(i, match.start, i, match.end), {
            title: 'Find asset references',
            command: 'ue58rider.findAssetReferences',
            arguments: [match.assetPath],
          }),
        );
      }
    }
    return lenses;
  }
}
