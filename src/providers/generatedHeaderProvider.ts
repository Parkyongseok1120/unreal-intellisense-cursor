import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Adjacent .generated.h include navigation from project headers */
export class GeneratedHeaderDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly getProjectRoot: () => string | undefined) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    const projectRoot = this.getProjectRoot();
    if (!projectRoot) return undefined;

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    const headerBase = path.basename(document.fileName, path.extname(document.fileName));

    // MyClass.generated.h include in MyClass.h
    if (document.fileName.endsWith('.h') && !document.fileName.includes('.generated.')) {
      const genPath = path.join(path.dirname(document.fileName), `${headerBase}.generated.h`);
      if (await exists(genPath)) {
        const genDoc = await vscode.workspace.openTextDocument(genPath);
        const pos = findSymbolInDocument(genDoc, word);
        if (pos) return new vscode.Location(vscode.Uri.file(genPath), pos);
      }
    }

    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function findSymbolInDocument(doc: vscode.TextDocument, symbol: string): vscode.Position | undefined {
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    if (new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(line)) {
      const col = line.indexOf(symbol);
      if (col >= 0) return new vscode.Position(i, col);
    }
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
