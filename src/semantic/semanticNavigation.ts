import * as vscode from 'vscode';
import * as path from 'path';
import type { UEProject } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UeClassSymbol } from '../projectModel/projectModelService';
import {
  getOrBuildSemanticGraph,
  querySymbol,
} from './semanticService';

type ProjectGetter = (document: vscode.TextDocument) => UEProject | undefined;

async function loadGraph(getProject: ProjectGetter, document: vscode.TextDocument) {
  const project = getProject(document);
  if (!project) return undefined;
  return getOrBuildSemanticGraph(project);
}

function authoritativeSymbols(graph: Awaited<ReturnType<typeof loadGraph>>): UeClassSymbol[] {
  if (!graph?.symbols?.length) return [];
  return graph.symbols.filter((s) => s.confidence === 'authoritative' || s.confidence === 'derived');
}

export class UeSemanticDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    const graph = await loadGraph(this.getProject, document);
    if (!graph) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);

    const sym = authoritativeSymbols(graph).find((s) => s.name === word);
    if (sym?.sourceFile) {
      const uri = vscode.Uri.file(sym.sourceFile);
      if (sym.sourceLine !== undefined && sym.sourceLine >= 0) {
        return new vscode.Location(uri, new vscode.Position(sym.sourceLine, 0));
      }
      const target = await vscode.workspace.openTextDocument(uri);
      const pos = findWordPosition(target, word);
      if (pos) return new vscode.Location(uri, pos);
    }

    const reflection = querySymbol(graph, word);
    if (reflection?.filePath) {
      const uri = vscode.Uri.file(reflection.filePath);
      const target = await vscode.workspace.openTextDocument(uri);
      const pos = findWordPosition(target, word);
      if (pos) return new vscode.Location(uri, pos);
    }

    return undefined;
  }
}

export class UeSemanticReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly _getProject: ProjectGetter) {}

  async provideReferences(): Promise<vscode.Location[] | undefined> {
    return undefined;
  }
}

export class UeSemanticDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const graph = await loadGraph(this.getProject, document);
    if (!graph) return [];

    const file = path.normalize(document.fileName).toLowerCase();
    const symbols: vscode.DocumentSymbol[] = [];
    for (const sym of authoritativeSymbols(graph)) {
      if (path.normalize(sym.sourceFile).toLowerCase() !== file) continue;
      const line = sym.sourceLine ?? 0;
      symbols.push(
        new vscode.DocumentSymbol(
          sym.name,
          sym.baseClass ? `extends ${sym.baseClass}` : '',
          vscode.SymbolKind.Class,
          new vscode.Range(line, 0, line, sym.name.length),
          new vscode.Range(line, 0, line, sym.name.length),
        ),
      );
    }
    return symbols;
  }
}

export class UeSemanticWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc) return [];
    const graph = await loadGraph(this.getProject, activeDoc);
    if (!graph || query.length < 2) return [];

    const q = query.toLowerCase();
    const out: vscode.SymbolInformation[] = [];
    for (const sym of authoritativeSymbols(graph)) {
      if (!sym.name.toLowerCase().includes(q)) continue;
      const uri = vscode.Uri.file(sym.sourceFile);
      const line = sym.sourceLine ?? 0;
      out.push(
        new vscode.SymbolInformation(
          sym.name,
          vscode.SymbolKind.Class,
          'UE',
          new vscode.Location(uri, new vscode.Position(line, 0)),
        ),
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
    const graph = await loadGraph(this.getProject, document);
    if (!graph) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const sym = authoritativeSymbols(graph).find(
      (s) => s.name === word && path.normalize(s.sourceFile).toLowerCase() === path.normalize(document.fileName).toLowerCase(),
    );
    if (!sym) return undefined;

    return new vscode.TypeHierarchyItem(
      vscode.SymbolKind.Class,
      sym.name,
      sym.baseClass ?? '',
      document.uri,
      new vscode.Range(sym.sourceLine ?? position.line, 0, sym.sourceLine ?? position.line, sym.name.length),
      new vscode.Range(sym.sourceLine ?? position.line, 0, sym.sourceLine ?? position.line, sym.name.length),
    );
  }

  async provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const graph = await loadGraph(this.getProject, doc);
    if (!graph) return [];

    const sym = authoritativeSymbols(graph).find((s) => s.name === item.name);
    if (!sym?.baseClass) return [];

    const parent = authoritativeSymbols(graph).find((s) => s.name === sym.baseClass);
    if (!parent) {
      return [
        new vscode.TypeHierarchyItem(
          vscode.SymbolKind.Class,
          sym.baseClass,
          '',
          item.uri,
          item.range,
          item.selectionRange ?? item.range,
        ),
      ];
    }

    return [
      new vscode.TypeHierarchyItem(
        vscode.SymbolKind.Class,
        parent.name,
        parent.baseClass ?? '',
        vscode.Uri.file(parent.sourceFile),
        new vscode.Range(parent.sourceLine ?? 0, 0, parent.sourceLine ?? 0, parent.name.length),
        new vscode.Range(parent.sourceLine ?? 0, 0, parent.sourceLine ?? 0, parent.name.length),
      ),
    ];
  }

  async provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const graph = await loadGraph(this.getProject, doc);
    if (!graph) return [];

    return authoritativeSymbols(graph)
      .filter((s) => s.baseClass === item.name)
      .map(
        (s) =>
          new vscode.TypeHierarchyItem(
            vscode.SymbolKind.Class,
            s.name,
            s.baseClass ?? '',
            vscode.Uri.file(s.sourceFile),
            new vscode.Range(s.sourceLine ?? 0, 0, s.sourceLine ?? 0, s.name.length),
            new vscode.Range(s.sourceLine ?? 0, 0, s.sourceLine ?? 0, s.name.length),
          ),
      );
  }
}

export class UeSemanticInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<vscode.InlayHint[]> {
    const graph = await loadGraph(this.getProject, document);
    if (!graph) return [];

    const hints: vscode.InlayHint[] = [];
    const file = path.normalize(document.fileName).toLowerCase();
    const mod = graph.modules.find((m) =>
      m.translationUnits.some((tu) => path.normalize(tu).toLowerCase() === file),
    );
    if (mod) {
      const line = Math.min(range.start.line, document.lineCount - 1);
      hints.push({
        position: new vscode.Position(line, 0),
        label: `module:${mod.name}`,
        kind: vscode.InlayHintKind.Type,
        paddingRight: true,
      });
    }
    return hints;
  }
}

function findWordPosition(doc: vscode.TextDocument, word: string): vscode.Position | undefined {
  const re = new RegExp(`\\b${escapeRegex(word)}\\b`);
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    const match = re.exec(line);
    if (match && match.index >= 0) return new vscode.Position(i, match.index);
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerSemanticNavigation(
  context: vscode.ExtensionContext,
  getProject: ProjectGetter,
  settings: UE5_8CursorSettings,
): void {
  const selector = { language: 'cpp', scheme: 'file' };

  if (settings.semanticNavigationEnabled) {
    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider(selector, new UeSemanticDefinitionProvider(getProject)),
      vscode.languages.registerReferenceProvider(selector, new UeSemanticReferenceProvider(getProject)),
      vscode.languages.registerDocumentSymbolProvider(selector, new UeSemanticDocumentSymbolProvider(getProject)),
      vscode.languages.registerWorkspaceSymbolProvider(new UeSemanticWorkspaceSymbolProvider(getProject)),
      vscode.languages.registerTypeHierarchyProvider(selector, new UeSemanticTypeHierarchyProvider(getProject)),
      vscode.languages.registerInlayHintsProvider(selector, new UeSemanticInlayHintsProvider(getProject)),
    );
  }
}
