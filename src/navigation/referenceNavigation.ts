import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import { findEnclosingUeClass } from './symbolNavigation';

const MODULE_SCAN_FILE_CAP = 50;

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function wordPattern(word: string): RegExp {
  return new RegExp(`\\b${escapeRegex(word)}\\b`);
}

function scanFileForWord(filePath: string, word: string, className?: string): vscode.Location[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const refs: vscode.Location[] = [];
  const lines = content.split(/\r?\n/);
  const isCpp = /\.cpp$/i.test(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!wordPattern(word).test(line)) continue;
    if (isCpp && className && !new RegExp(`\\b${escapeRegex(className)}::${escapeRegex(word)}\\b`).test(line)) {
      if (!wordPattern(word).test(line)) continue;
    }
    const column = Math.max(0, line.indexOf(word));
    refs.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Range(i, column, i, column + word.length)));
  }
  return refs;
}

function moduleDirectoryForFile(filePath: string, projectRoot: string): string | undefined {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const match = relative.match(/^(.*?\/(?:Public|Private|Classes))(?:\/|$)/i)
    ?? relative.match(/^((?:Plugins\/.+\/Source|Source)\/[^/]+)/i);
  if (!match) return undefined;
  return path.resolve(projectRoot, match[1]);
}

function listModuleFiles(moduleDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    if (results.length >= MODULE_SCAN_FILE_CAP) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MODULE_SCAN_FILE_CAP) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:cpp|h|hpp|inl)$/i.test(entry.name)) results.push(full);
    }
  };
  walk(moduleDir);
  return results;
}

export function findUeReferences(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: { projectRoot?: string; moduleScan?: boolean } = {},
): vscode.Location[] {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!wordRange) return [];
  const word = document.getText(wordRange);
  if (word.length < 2) return [];

  const projectRoot = options.projectRoot;
  const className = findEnclosingUeClass(document, position.line);
  const refs: vscode.Location[] = [];
  const seen = new Set<string>();

  const addRefs = (locations: vscode.Location[]) => {
    for (const loc of locations) {
      const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(loc);
    }
  };

  addRefs(scanFileForWord(document.fileName, word, className));

  const paired = findPairedSourceFile(document.fileName);
  if (paired) addRefs(scanFileForWord(paired, word, className));

  if (options.moduleScan && projectRoot) {
    const moduleDir = moduleDirectoryForFile(document.fileName, projectRoot);
    if (moduleDir) {
      for (const file of listModuleFiles(moduleDir)) {
        if (file === document.fileName || file === paired) continue;
        addRefs(scanFileForWord(file, word, className));
      }
    }
  }

  return refs;
}

export class UePairedReferenceProvider implements vscode.ReferenceProvider {
  constructor(
    private readonly projectRoot: () => string | undefined,
    private readonly moduleScan: () => boolean,
  ) {}

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] {
    const root = this.projectRoot();
    if (!root) return [];
    return findUeReferences(document, position, {
      projectRoot: root,
      moduleScan: this.moduleScan(),
    });
  }
}
