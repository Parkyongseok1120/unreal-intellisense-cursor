import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findGeneratedPair, getOrBuildSemanticGraph } from '../semantic/semanticService';
import type { UEProject } from '../types';

type ProjectGetter = (document: vscode.TextDocument) => UEProject | undefined;

/** Generated header navigation from #include lines and semantic graph */
export class GeneratedHeaderDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly getProject: ProjectGetter) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    const project = this.getProject(document);
    if (!project) return undefined;

    const line = document.lineAt(position.line).text;
    const includeMatch = line.match(/#include\s+"([^"]+\.generated\.h)"/);
    if (includeMatch) {
      const genName = path.basename(includeMatch[1]);
      const generated = await resolveGeneratedPath(project, document.fileName, genName);
      if (generated) {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (wordRange) {
          const word = document.getText(wordRange);
          const pos = findSymbolInFile(generated, word);
          if (pos) return new vscode.Location(vscode.Uri.file(generated), pos);
        }
        return new vscode.Location(vscode.Uri.file(generated), new vscode.Position(0, 0));
      }
    }

    return undefined;
  }
}

async function resolveGeneratedPath(
  project: UEProject,
  currentFile: string,
  genBasename: string,
): Promise<string | undefined> {
  try {
    const graph = await getOrBuildSemanticGraph(project);
    const pair = findGeneratedPair(graph, currentFile);
    if (pair?.generated && fs.existsSync(pair.generated)) return pair.generated;
  } catch {
    // optional graph
  }

  const adjacent = path.join(path.dirname(currentFile), genBasename);
  if (fs.existsSync(adjacent)) return adjacent;

  const intermediate = path.join(project.projectRoot, 'Intermediate', 'Build');
  const matches: string[] = [];
  await walkGenerated(intermediate, genBasename, 10, matches);
  if (matches.length > 0) return matches[0];

  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const entry of await fs.promises.readdir(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginIntermediate = path.join(pluginsDir, entry.name, 'Intermediate', 'Build');
      await walkGenerated(pluginIntermediate, genBasename, 8, matches);
    }
  }
  return matches[0];
}

async function walkGenerated(dir: string, genBasename: string, depth: number, matches: string[]): Promise<void> {
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === genBasename) {
      matches.push(full);
    } else if (entry.isDirectory()) {
      await walkGenerated(full, genBasename, depth - 1, matches);
    }
  }
}

function findSymbolInFile(filePath: string, symbol: string): vscode.Position | undefined {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const match = re.exec(lines[i]);
    if (match && match.index !== undefined) return new vscode.Position(i, match.index);
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
