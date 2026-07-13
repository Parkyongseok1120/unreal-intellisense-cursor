import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UEProject } from '../types';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import { parseHeaderUFunctions } from '../uht/generatedHeaderParser';
import {
  findGeneratedPair,
  getOrBuildSemanticGraph,
  querySymbol,
} from '../semantic/semanticService';
import { isUhtMacroToken } from './stubPaths';

export interface NavigationResolveOptions {
  project?: UEProject;
  mode?: 'definition' | 'implementation';
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/;
const HEADER_EXTS = new Set(['.h', '.hpp', '.inl']);
const SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx']);

export function getSymbolAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): { word: string; range: vscode.Range } | undefined {
  const wordRange = document.getWordRangeAtPosition(position, IDENT_RE);
  if (!wordRange) return undefined;
  return { word: document.getText(wordRange), range: wordRange };
}

const NON_CLASS_QUALIFIERS = new Set(['Super', 'Self', 'ThisClass', 'StaticClass', 'FObjectInitializer']);

export function findEnclosingUeClass(document: vscode.TextDocument, line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const text = document.lineAt(i).text;
    const methodImpl = text.match(/\b(\w+)::\s*\w+\s*\(/);
    if (methodImpl && !NON_CLASS_QUALIFIERS.has(methodImpl[1])) return methodImpl[1];
    const uclass = text.match(/UCLASS\s*\([^)]*\)\s*class\s+(?:\w+_API\s+)?(\w+)/);
    if (uclass) return uclass[1];
    const plain = text.match(/class\s+(?:\w+_API\s+)?(\w+)\s*:\s*(?:public|private|protected)\b/i);
    if (plain && i <= line) return plain[1];
    const plainStruct = text.match(/(?:USTRUCT\s*\([^)]*\)\s*)?struct\s+(?:\w+_API\s+)?(\w+)/);
    if (plainStruct && i <= line) {
      const structIdx = text.indexOf(plainStruct[0]);
      const beforeStruct = structIdx >= 0 ? text.slice(0, structIdx) : text;
      if (!beforeStruct.includes('(')) return plainStruct[1];
    }
  }
  return undefined;
}

export function findSymbolInFile(filePath: string, patterns: RegExp[]): vscode.Position | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) continue;
      const index = match.index ?? line.search(pattern);
      if (index >= 0) return new vscode.Position(i, index);
    }
  }
  return undefined;
}

function locationFromFile(filePath: string, position: vscode.Position): vscode.Location {
  return new vscode.Location(vscode.Uri.file(filePath), position);
}

function isHeader(filePath: string): boolean {
  return HEADER_EXTS.has(path.extname(filePath).toLowerCase());
}

function isSource(filePath: string): boolean {
  return SOURCE_EXTS.has(path.extname(filePath).toLowerCase());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveFromSemanticGraph(
  project: UEProject,
  word: string,
  currentFile: string,
): Promise<vscode.Location | undefined> {
  if (!isUeClassTypeSymbol(word)) return undefined;

  const graph = await getOrBuildSemanticGraph(project);
  const symbols = graph.symbols.filter((s) => s.confidence === 'authoritative' || s.confidence === 'derived');
  const sym = symbols.find((s) => s.name === word);
  if (sym?.sourceFile) {
    if (sym.sourceLine !== undefined && sym.sourceLine >= 0) {
      return locationFromFile(sym.sourceFile, new vscode.Position(sym.sourceLine, 0));
    }
    const pos = findSymbolInFile(sym.sourceFile, [new RegExp(`\\b${escapeRegex(word)}\\b`)]);
    if (pos) return locationFromFile(sym.sourceFile, pos);
  }

  const reflection = querySymbol(graph, word);
  if (reflection?.filePath) {
    const pos = findSymbolInFile(reflection.filePath, [new RegExp(`\\b${escapeRegex(word)}\\b`)]);
    if (pos) return locationFromFile(reflection.filePath, pos);
  }

  return undefined;
}

function resolveMethodInHeader(
  headerPath: string,
  className: string | undefined,
  methodName: string,
): vscode.Location | undefined {
  const patterns: RegExp[] = [
    new RegExp(`\\b${escapeRegex(methodName)}\\s*\\(`),
    new RegExp(`\\b${escapeRegex(methodName)}_Implementation\\s*\\(`),
  ];
  const pos = findSymbolInFile(headerPath, patterns);
  return pos ? locationFromFile(headerPath, pos) : undefined;
}

function findMethodSignatureInSource(
  sourcePath: string,
  className: string | undefined,
  methodName: string,
): vscode.Position | undefined {
  let content: string;
  try {
    content = fs.readFileSync(sourcePath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  const patterns: RegExp[] = [];
  if (className) {
    patterns.push(
      new RegExp(`\\b${escapeRegex(className)}::${escapeRegex(methodName)}\\s*\\(`),
      new RegExp(`\\b${escapeRegex(className)}::${escapeRegex(methodName)}_Implementation\\s*\\(`),
    );
  } else {
    patterns.push(
      new RegExp(`\\b\\w+::${escapeRegex(methodName)}\\s*\\(`),
      new RegExp(`\\b\\w+::${escapeRegex(methodName)}_Implementation\\s*\\(`),
    );
  }

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(lines[i]);
      if (!match) continue;
      const index = match.index ?? lines[i].search(pattern);
      if (index >= 0) return new vscode.Position(i, index);
    }
    if (className) {
      const sig = new RegExp(`\\b${escapeRegex(className)}::${escapeRegex(methodName)}\\s*\\([^)]*\\)\\s*(?:const)?\\s*$`);
      if (sig.test(lines[i].trim()) && i + 1 < lines.length && lines[i + 1].trim().startsWith('{')) {
        return new vscode.Position(i, lines[i].indexOf('::') + 2);
      }
    }
  }
  return undefined;
}

function resolveMethodInSource(
  sourcePath: string,
  className: string | undefined,
  methodName: string,
): vscode.Location | undefined {
  const qualified = findMethodSignatureInSource(sourcePath, className, methodName);
  if (qualified) return locationFromFile(sourcePath, qualified);

  const patterns: RegExp[] = [
    new RegExp(`\\b${escapeRegex(methodName)}\\s*\\([^)]*\\)\\s*(?:const)?\\s*\\{`),
    new RegExp(`\\b${escapeRegex(methodName)}_Implementation\\s*\\(`),
  ];
  const pos = findSymbolInFile(sourcePath, patterns);
  return pos ? locationFromFile(sourcePath, pos) : undefined;
}

export function hasMemberInHeader(headerPath: string, memberName: string): boolean {
  const patterns: RegExp[] = [
    new RegExp(`[\\w:<>,\\s*&]+\\s+${escapeRegex(memberName)}\\s*;`),
    new RegExp(`[\\w:<>,\\s*&]+\\s+${escapeRegex(memberName)}\\s*=`),
    new RegExp(`\\b${escapeRegex(memberName)}\\s*\\{`),
  ];
  return findSymbolInFile(headerPath, patterns) !== undefined;
}

function resolveMemberInHeader(
  headerPath: string,
  _className: string | undefined,
  memberName: string,
): vscode.Location | undefined {
  const patterns: RegExp[] = [
    new RegExp(`[\\w:<>,\\s*&]+\\s+${escapeRegex(memberName)}\\s*;`),
    new RegExp(`[\\w:<>,\\s*&]+\\s+${escapeRegex(memberName)}\\s*=`),
    new RegExp(`\\b${escapeRegex(memberName)}\\s*\\{`),
  ];
  const pos = findSymbolInFile(headerPath, patterns);
  return pos ? locationFromFile(headerPath, pos) : undefined;
}

export function isHeaderMethodDeclarationLine(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
): boolean {
  if (!isHeader(document.fileName)) return false;
  const line = document.lineAt(position.line).text;
  return new RegExp(
    `\\b${escapeRegex(word)}\\s*\\([^)]*\\)\\s*(?:const)?\\s*(?:override|final)?\\s*;`,
  ).test(line);
}

export function resolvePairedFileNavigation(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
  mode: 'definition' | 'implementation',
): vscode.Location | undefined {
  const currentPath = document.fileName;
  const paired = findPairedSourceFile(currentPath);
  if (!paired) return undefined;

  const className = findEnclosingUeClass(document, position.line);

  if (isHeader(currentPath)) {
    if (!isHeaderMethodDeclarationLine(document, position, word) && !isUfunctionMethodContext(document, position, word)) {
      return undefined;
    }
    const impl = resolveMethodInSource(paired, className, word);
    const decl = resolveMethodInHeader(currentPath, className, word);
    if (mode === 'implementation') return impl;
    return impl;
  }

  if (isSource(currentPath)) {
    if (mode === 'implementation') {
      return resolveMethodInSource(currentPath, className, word);
    }
    const decl = resolveMethodInHeader(paired, className, word);
    if (decl) return decl;
    return resolveMemberInHeader(paired, className, word);
  }

  return undefined;
}

function resolveMethodNavigation(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
  mode: 'definition' | 'implementation',
): vscode.Location | undefined {
  const pairedResult = resolvePairedFileNavigation(document, position, word, mode);
  if (pairedResult) return pairedResult;

  const currentPath = document.fileName;
  const className = findEnclosingUeClass(document, position.line);

  if (isHeader(currentPath)) {
    return resolveMethodInHeader(currentPath, className, word);
  }
  if (isSource(currentPath)) {
    return resolveMethodInSource(currentPath, className, word);
  }
  return undefined;
}

async function walkGeneratedHeaders(rootDir: string, className: string, depth: number, matches: string[]): Promise<void> {
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const stripped = className.replace(/^[AUIFG]/, '');
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.generated.h')) {
      if (entry.name === `${className}.generated.h` || entry.name === `${stripped}.generated.h`) {
        matches.push(full);
      }
    } else if (entry.isDirectory()) {
      await walkGeneratedHeaders(full, className, depth - 1, matches);
    }
  }
}

async function findGeneratedHeaderForClass(projectRoot: string, className: string): Promise<string | undefined> {
  const matches: string[] = [];
  const searchRoots = [path.join(projectRoot, 'Intermediate', 'Build')];

  const pluginsDir = path.join(projectRoot, 'Plugins');
  if (fs.existsSync(pluginsDir)) {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true }).catch(() => []);
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginIntermediate = path.join(pluginsDir, plugin.name, 'Intermediate', 'Build');
      if (fs.existsSync(pluginIntermediate)) searchRoots.push(pluginIntermediate);
    }
  }

  for (const root of searchRoots) {
    await walkGeneratedHeaders(root, className, 10, matches);
  }
  if (matches.length > 0) {
    return matches.sort((a, b) => a.length - b.length)[0];
  }

  for (const root of searchRoots) {
    const allGenerated: string[] = [];
    async function collectAll(dir: string, depth: number): Promise<void> {
      if (depth <= 0) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.generated.h')) {
          allGenerated.push(full);
        } else if (entry.isDirectory()) {
          await collectAll(full, depth - 1);
        }
      }
    }
    await collectAll(root, 10);
    for (const candidate of allGenerated) {
      try {
        const content = await fs.promises.readFile(candidate, 'utf-8');
        if (content.includes(`${className}::StaticClass`) || content.includes(`Z_Construct_UClass_${className}`)) {
          return candidate;
        }
      } catch {
        // skip
      }
    }
  }
  return undefined;
}

async function resolveStaticClass(
  document: vscode.TextDocument,
  position: vscode.Position,
  project?: UEProject,
): Promise<vscode.Location | undefined> {
  if (!project) return undefined;

  const line = document.lineAt(position.line).text;
  const callMatch = line.match(/(\w+)::StaticClass\s*\(/);
  const className = callMatch?.[1] ?? findEnclosingUeClass(document, position.line);
  if (!className) return undefined;

  return resolveStaticClassForType(project, document.fileName, className);
}

async function resolveStaticClassForType(
  project: UEProject,
  currentFile: string,
  className: string,
): Promise<vscode.Location | undefined> {
  try {
    const graph = await getOrBuildSemanticGraph(project);
    const pair = findGeneratedPair(graph, currentFile);
    if (pair?.generated) {
      const pos = findStaticClassPosition(pair.generated, className);
      if (pos) return locationFromFile(pair.generated, pos);
    }
  } catch {
    // optional graph
  }

  const pairedHeader = isSource(currentFile)
    ? findPairedSourceFile(currentFile)
    : isHeader(currentFile)
      ? currentFile
      : undefined;
  if (pairedHeader) {
    const includeMatch = fs.readFileSync(pairedHeader, 'utf-8').match(/#include\s+"([^"]+\.generated\.h)"/);
    if (includeMatch) {
      const genName = path.basename(includeMatch[1]);
      const genFromIntermediate = await findGeneratedHeaderForClass(project.projectRoot, className);
      if (genFromIntermediate && path.basename(genFromIntermediate) === genName) {
        const pos = findStaticClassPosition(genFromIntermediate, className);
        if (pos) return locationFromFile(genFromIntermediate, pos);
      }
    }
  }

  const generated = await findGeneratedHeaderForClass(project.projectRoot, className);
  if (generated) {
    const pos = findStaticClassPosition(generated, className);
    if (pos) return locationFromFile(generated, pos);
  }
  return undefined;
}

function findStaticClassPosition(generatedPath: string, className: string): vscode.Position | undefined {
  const patterns = [
    new RegExp(`\\b${escapeRegex(className)}\\s*::\\s*StaticClass\\s*\\(`),
    new RegExp(`\\bZ_Construct_UClass_${escapeRegex(className)}\\s*\\(`),
  ];
  return findSymbolInFile(generatedPath, patterns);
}

export function isUfunctionMethodContext(document: vscode.TextDocument, position: vscode.Position, word: string): boolean {
  if (!isHeader(document.fileName)) return false;
  const funcs = parseHeaderUFunctions(document.getText());
  return funcs.some((fn) => fn.name === word || fn.name === `${word}_Implementation`);
}

export function isUeClassTypeSymbol(word: string): boolean {
  return /^(U|A|F|I|E|G)[A-Z]\w{2,}/.test(word);
}

export function isPriorityPairedNavigationCandidate(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
  mode: 'definition' | 'implementation',
): boolean {
  if (isHeader(document.fileName)) {
    return isHeaderMethodDeclarationLine(document, position, word) || isUfunctionMethodContext(document, position, word);
  }

  if (isSource(document.fileName)) {
    if (isMethodNavigationCandidate(document, position, word)) return true;
    if (mode !== 'definition') return false;
    const paired = findPairedSourceFile(document.fileName);
    if (paired && hasMemberInHeader(paired, word)) return true;
  }

  return false;
}

export function isMethodNavigationCandidate(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
): boolean {
  if (isUfunctionMethodContext(document, position, word)) return true;

  const line = document.lineAt(position.line).text;
  if (new RegExp(`\\w+::${escapeRegex(word)}\\b`).test(line)) return true;

  if (isHeader(document.fileName)) {
    if (new RegExp(`\\b${escapeRegex(word)}\\s*\\([^)]*\\)\\s*(?:const)?\\s*;`).test(line)) return true;
    return false;
  }

  if (isSource(document.fileName)) {
    if (new RegExp(`\\w+::${escapeRegex(word)}\\s*\\(`).test(line)) return true;
  }

  return false;
}

export async function resolveUeNavigationTarget(
  document: vscode.TextDocument,
  position: vscode.Position,
  options?: NavigationResolveOptions,
): Promise<vscode.Location | undefined> {
  const symbol = getSymbolAtPosition(document, position);
  if (!symbol) return undefined;

  const { word } = symbol;
  const mode = options?.mode ?? 'definition';

  if (isUhtMacroToken(word)) {
    return undefined;
  }

  if (word === 'StaticClass') {
    const staticLoc = await resolveStaticClass(document, position, options?.project);
    if (staticLoc) return staticLoc;
  }

  if (isMethodNavigationCandidate(document, position, word)) {
    const methodLoc = resolveMethodNavigation(document, position, word, mode);
    if (methodLoc) return methodLoc;
  }

  if (options?.project && isUeClassTypeSymbol(word)) {
    const graphLoc = await resolveFromSemanticGraph(options.project, word, document.fileName);
    if (graphLoc) return graphLoc;
  }

  return undefined;
}

export function isEngineSourcePath(filePath: string, projectRoot?: string, engineRoot?: string): boolean {
  const normalized = path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
  const projectNorm = projectRoot ? path.normalize(projectRoot).replace(/\\/g, '/').toLowerCase() : undefined;
  if (projectNorm && normalized.startsWith(projectNorm)) {
    return false;
  }
  if (engineRoot) {
    const engineNorm = path.normalize(engineRoot).replace(/\\/g, '/').toLowerCase();
    if (normalized.startsWith(engineNorm)) return true;
  }
  return (
    normalized.includes('/engine/') ||
    normalized.includes('/unrealengine/') ||
    normalized.includes('/epic games/ue_') ||
    normalized.includes('/engine/build/') ||
    (normalized.includes('/engine/plugins/') && !projectNorm)
  );
}

export interface PickBestDefinitionOptions {
  projectRoot?: string;
  pairedFilePath?: string;
  engineRoot?: string;
}

export function pickBestDefinitionLocation(
  locations: vscode.Location[],
  currentDocument: vscode.TextDocument,
  preferredWord?: string,
  options?: PickBestDefinitionOptions,
): vscode.Location | undefined {
  if (locations.length === 0) return undefined;
  const currentPath = path.normalize(currentDocument.fileName).toLowerCase();
  const pairedPath = options?.pairedFilePath
    ? path.normalize(options.pairedFilePath).toLowerCase()
    : undefined;
  const projectRoot = options?.projectRoot
    ? path.normalize(options.projectRoot).toLowerCase()
    : undefined;

  const scored = locations.map((loc) => {
    const targetPath = path.normalize(loc.uri.fsPath).toLowerCase();
    let score = 0;
    if (targetPath !== currentPath) score += 10;
    if (pairedPath && targetPath === pairedPath) score += 25;
    if (projectRoot && targetPath.startsWith(projectRoot)) score += 8;
    if (targetPath.endsWith('.generated.h') && preferredWord === 'StaticClass') score += 8;
    if (targetPath.endsWith('.h') || targetPath.endsWith('.hpp')) score += 4;
    if (targetPath.endsWith('.cpp') || targetPath.endsWith('.cxx') || targetPath.endsWith('.cc')) score += 4;
    if (targetPath.includes(`${path.sep}intermediate${path.sep}`) && preferredWord === 'StaticClass') score += 2;
    if (isEngineSourcePath(targetPath, options?.projectRoot, options?.engineRoot)) score -= 20;
    return { loc, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.loc;
}
