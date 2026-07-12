import * as vscode from 'vscode';
import * as path from 'path';
import type { UEProject } from '../types';
import {
  findGeneratedPair,
  getOrBuildSemanticGraph,
  querySymbol,
} from './semanticService';

type ProjectGetter = () => UEProject | undefined;

async function loadGraph(getProject: ProjectGetter) {
  const project = getProject();
  if (!project) return undefined;
  return getOrBuildSemanticGraph(project);
}

export class UeSemanticDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);

    const reflection = querySymbol(graph, word);
    if (reflection?.filePath) {
      const uri = vscode.Uri.file(reflection.filePath);
      const target = await vscode.workspace.openTextDocument(uri);
      const pos = findWordPosition(target, word);
      if (pos) return new vscode.Location(uri, pos);
    }

    const pair = findGeneratedPair(graph, document.fileName);
    if (pair?.generated && document.fileName.endsWith('.h')) {
      const uri = vscode.Uri.file(pair.generated);
      const target = await vscode.workspace.openTextDocument(uri);
      const pos = findWordPosition(target, word);
      if (pos) return new vscode.Location(uri, pos);
    }

    return undefined;
  }
}

export class UeSemanticReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const locations: vscode.Location[] = [];

    for (const cls of graph.reflection) {
      if (cls.className !== word) continue;
      if (cls.filePath) {
        const uri = vscode.Uri.file(cls.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = findWordPosition(doc, word);
        if (pos) locations.push(new vscode.Location(uri, pos));
      }
    }

    for (const mod of graph.modules) {
      for (const tu of mod.translationUnits) {
        if (!tu.toLowerCase().includes(word.toLowerCase())) continue;
        locations.push(new vscode.Location(vscode.Uri.file(tu), new vscode.Position(0, 0)));
      }
    }

    return locations.length > 0 ? locations : undefined;
  }
}

export class UeSemanticDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return [];

    const file = path.normalize(document.fileName).toLowerCase();
    const symbols: vscode.DocumentSymbol[] = [];

    for (const cls of graph.reflection) {
      if (!cls.filePath || path.normalize(cls.filePath).toLowerCase() !== file) continue;
      const range = new vscode.Range(0, 0, 0, 0);
      const sym = new vscode.DocumentSymbol(cls.className, 'UCLASS', vscode.SymbolKind.Class, range, range);
      for (const prop of cls.properties ?? []) {
        const child = new vscode.DocumentSymbol(
          prop.name,
          'UPROPERTY',
          vscode.SymbolKind.Property,
          range,
          range,
        );
        sym.children.push(child);
      }
      for (const fn of cls.functions ?? []) {
        const child = new vscode.DocumentSymbol(
          fn.name,
          'UFUNCTION',
          vscode.SymbolKind.Method,
          range,
          range,
        );
        sym.children.push(child);
      }
      symbols.push(sym);
    }

    return symbols;
  }
}

export class UeSemanticWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return [];

    const q = query.toLowerCase();
    const out: vscode.SymbolInformation[] = [];
    for (const cls of graph.reflection) {
      if (!cls.className.toLowerCase().includes(q)) continue;
      const uri = cls.filePath ? vscode.Uri.file(cls.filePath) : vscode.Uri.file(graph.projectRoot);
      out.push(
        new vscode.SymbolInformation(cls.className, vscode.SymbolKind.Class, 'UE', new vscode.Location(uri, new vscode.Position(0, 0))),
      );
    }
    for (const mod of graph.modules) {
      if (!mod.name.toLowerCase().includes(q)) continue;
      out.push(
        new vscode.SymbolInformation(mod.name, vscode.SymbolKind.Module, 'UE Module', new vscode.Location(vscode.Uri.file(graph.projectRoot), new vscode.Position(0, 0))),
      );
    }
    return out;
  }
}

export class UeSemanticTypeHierarchyProvider implements vscode.TypeHierarchyProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async prepareTypeHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.TypeHierarchyItem | undefined> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return undefined;
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const cls = querySymbol(graph, word);
    if (!cls) return undefined;
    return new vscode.TypeHierarchyItem(
      vscode.SymbolKind.Class,
      word,
      '',
      document.uri,
      wordRange,
      wordRange,
    );
  }

  async provideTypeHierarchySupertypes(): Promise<vscode.TypeHierarchyItem[] | undefined> {
    return [];
  }

  async provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return [];
    return graph.reflection
      .filter((c) => c.className !== item.name)
      .slice(0, 8)
      .map((c) => new vscode.TypeHierarchyItem(
        vscode.SymbolKind.Class,
        c.className,
        '',
        item.uri,
        item.range,
        item.range,
      ));
  }
}

export class UeSemanticInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<vscode.InlayHint[]> {
    const graph = await loadGraph(this.getProject);
    if (!graph) return [];

    const hints: vscode.InlayHint[] = [];
    const file = path.normalize(document.fileName).toLowerCase();
    const mod = graph.modules.find((m) =>
      m.translationUnits.some((tu) => path.normalize(tu).toLowerCase() === file),
    );
    if (mod) {
      const line = Math.min(range.start.line, document.lineCount - 1);
      const pos = new vscode.Position(line, 0);
      hints.push({
        position: pos,
        label: `module:${mod.name}`,
        kind: vscode.InlayHintKind.Type,
        paddingRight: true,
      });
    }

    for (const cls of graph.reflection) {
      if (!cls.filePath || path.normalize(cls.filePath).toLowerCase() !== file) continue;
      for (let i = range.start.line; i <= range.end.line && i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        if (/\bUCLASS\s*\(/.test(text)) {
          hints.push({
            position: new vscode.Position(i, text.indexOf('UCLASS')),
            label: 'UHT',
            kind: vscode.InlayHintKind.Parameter,
            paddingRight: true,
          });
        }
      }
    }

    return hints;
  }
}

function findWordPosition(doc: vscode.TextDocument, word: string): vscode.Position | undefined {
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    const idx = line.indexOf(word);
    if (idx >= 0) return new vscode.Position(i, idx);
  }
  return undefined;
}

export function registerSemanticNavigation(
  context: vscode.ExtensionContext,
  getProject: ProjectGetter,
): void {
  const selector = { language: 'cpp', scheme: 'file' };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new UeSemanticDefinitionProvider(getProject)),
    vscode.languages.registerReferenceProvider(selector, new UeSemanticReferenceProvider(getProject)),
    vscode.languages.registerDocumentSymbolProvider(selector, new UeSemanticDocumentSymbolProvider(getProject)),
    vscode.languages.registerWorkspaceSymbolProvider(new UeSemanticWorkspaceSymbolProvider(getProject)),
    vscode.languages.registerTypeHierarchyProvider(selector, new UeSemanticTypeHierarchyProvider(getProject)),
    vscode.languages.registerInlayHintsProvider(selector, new UeSemanticInlayHintsProvider(getProject)),
  );
}
