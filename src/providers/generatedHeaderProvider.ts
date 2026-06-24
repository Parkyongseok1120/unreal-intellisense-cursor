import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveBinariesPlatformDir } from '../platform/platform';

/** .generated.h 및 Intermediate/Inc 심볼 정의로 이동 */
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

    // Search Intermediate/Inc
    const incHits = await findInIntermediateInc(projectRoot, headerBase, word);
    for (const hit of incHits) {
      const doc = await vscode.workspace.openTextDocument(hit);
      const pos = findSymbolInDocument(doc, word);
      if (pos) return new vscode.Location(vscode.Uri.file(hit), pos);
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

async function findInIntermediateInc(
  projectRoot: string,
  moduleBase: string,
  symbol: string,
): Promise<string[]> {
  const hits: string[] = [];
  const plat = resolveBinariesPlatformDir();
  const incRoots = [
    path.join(projectRoot, 'Intermediate', 'Build'),
    path.join(projectRoot, 'Intermediate', 'Build', plat),
  ];

  for (const root of incRoots) {
    await searchGenHeaders(root, moduleBase, hits, 8);
  }
  return hits;
}

async function searchGenHeaders(dir: string, moduleBase: string, hits: string[], depth: number): Promise<void> {
  if (depth <= 0) return;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.generated.h') && e.name.includes(moduleBase)) {
        hits.push(full);
      } else if (e.isDirectory() && (e.name === 'Inc' || e.name.includes('Editor'))) {
        await searchGenHeaders(full, moduleBase, hits, depth - 1);
      }
    }
  } catch {
    // ignore
  }
}
