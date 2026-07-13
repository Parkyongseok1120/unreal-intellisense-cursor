import * as path from 'path';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UEProject } from '../types';
import { discoverModuleLayouts } from '../parsers/moduleLayout';
import { discoverTargetsSync } from '../build/targetResolver';
import { fileExists } from '../platform/paths';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { buildReflectionIndex, type UClassReflection } from '../uht/reflectionIndex';
import { findUhtManifest, parseUhtManifestInputFiles } from '../uht/uhtRunner';
import { buildStableSymbolId } from './symbolModel';
import type { DeclarationRange, SymbolMember } from './symbolModel';
import { ensureDataDir } from '../platform/dataDir';
import * as fs from 'fs';
import { parseWindowsCommandLine, resolveCompilePath, canonicalCompilePath } from './windowsCommandLine';
import { normalizeParityArgs } from './rspActionImporter';

export const SEMANTIC_GRAPH_VERSION = 2;
const SEMANTIC_GRAPH_FILE = 'semantic-graph.json';

export type SymbolConfidence = 'authoritative' | 'derived' | 'heuristic';
export type SymbolProvenance = 'uht' | 'generated-header' | 'source-parser' | 'editor-bridge';

export interface UeClassSymbol {
  id: string;
  name: string;
  sourceFile: string;
  sourceLine?: number;
  classLine?: number;
  declarationRange?: DeclarationRange;
  baseClass?: string;
  interfaces?: string[];
  generatedHeader?: string;
  moduleName?: string;
  members?: SymbolMember[];
  provenance: SymbolProvenance;
  confidence: SymbolConfidence;
  generation?: number;
  fingerprint?: string;
}

export interface ProjectModelGraph {
  projectRoot: string;
  modules: ModuleNode[];
  plugins: string[];
  targets: string[];
}

export interface SemanticGraph {
  version: number;
  projectRoot: string;
  updatedAt: string;
  generation?: number;
  fingerprint?: string;
  engineId?: string;
  provenance?: string;
  synthetic?: boolean;
  modules: ModuleNode[];
  plugins: PluginNode[];
  targets: TargetNode[];
  reflection: UClassReflection[];
  symbols: UeClassSymbol[];
  compileActions: CompileAction[];
  generatedArtifacts: GeneratedArtifact[];
}

export interface ModuleNode {
  name: string;
  root: string;
  publicDir?: string;
  privateDir?: string;
  publicHeaders: string[];
  translationUnits: string[];
  buildCsDeps?: { public: string[]; private: string[] };
}

export interface PluginNode {
  name: string;
  modules: string[];
}

export interface TargetNode {
  name: string;
  path: string;
}

export interface GeneratedArtifact {
  headerPath: string;
  generatedPath: string;
  className?: string;
}

export interface CompileAction {
  file: string;
  arguments: string[];
  hash: string;
  directory?: string;
  targetKey?: string;
  synthetic?: boolean;
}

function normalizeArgs(args: string[]): string {
  return args
    .map((a) => a.replace(/\\/g, '/'))
    .filter((a) => a.length > 0)
    .join('\0');
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function buildProjectModel(project: UEProject): Promise<ProjectModelGraph> {
  const graph = await buildSemanticGraph(project);
  return {
    projectRoot: graph.projectRoot,
    modules: graph.modules,
    plugins: graph.plugins.map((p) => p.name),
    targets: graph.targets.map((t) => t.name),
  };
}

export async function buildSemanticGraph(project: UEProject): Promise<SemanticGraph> {
  const layouts = await discoverModuleLayouts(project.projectRoot);
  const modules: ModuleNode[] = [];

  for (const layout of layouts) {
    const tus: string[] = [];
    const headers: string[] = [];
    if (layout.privateDir && (await fileExists(layout.privateDir))) {
      await collectSourceFiles(layout.privateDir, tus, ['.cpp']);
    }
    if (layout.publicDir && (await fileExists(layout.publicDir))) {
      await collectSourceFiles(layout.publicDir, headers, ['.h', '.hpp', '.inl']);
    }
    if (layout.classesDir && (await fileExists(layout.classesDir))) {
      await collectSourceFiles(layout.classesDir, headers, ['.h', '.hpp', '.inl']);
    }
    if (layout.privateDir && (await fileExists(layout.privateDir))) {
      await collectSourceFiles(layout.privateDir, headers, ['.h', '.hpp', '.inl']);
    }
    const buildCs = path.join(layout.moduleRoot, `${layout.moduleName}.Build.cs`);
    const deps = (await fileExists(buildCs)) ? parseBuildCsDeps(buildCs) : undefined;
    modules.push({
      name: layout.moduleName,
      root: layout.moduleRoot,
      publicDir: layout.publicDir,
      privateDir: layout.privateDir,
      publicHeaders: headers,
      translationUnits: tus,
      buildCsDeps: deps,
    });
  }

  const plugins: PluginNode[] = [];
  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  if (await fileExists(pluginsDir)) {
    const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginNeedle = path.join('Plugins', entry.name).replace(/\\/g, '/').toLowerCase();
      const pluginModules = modules
        .filter((m) => m.root.replace(/\\/g, '/').toLowerCase().includes(pluginNeedle))
        .map((m) => m.name);
      plugins.push({ name: entry.name, modules: pluginModules });
    }
  }

  const targets = discoverTargetsSync(project.projectRoot).map((t) => ({ name: t.name, path: t.path }));
  const reflection = await buildReflectionIndex(project.projectRoot);
  const compileActions = await collectCompileActionsFromProject(project.projectRoot);
  const generatedArtifacts = await linkGeneratedArtifacts(project, reflection);

  const symbols = reflectionToSymbols(reflection, generatedArtifacts, modules);

  return {
    version: SEMANTIC_GRAPH_VERSION,
    projectRoot: project.projectRoot,
    updatedAt: new Date().toISOString(),
    generation: Date.now(),
    fingerprint: hashString(JSON.stringify({ modules: modules.length, reflection: reflection.length })),
    provenance: 'uht',
    modules,
    plugins,
    targets,
    reflection,
    symbols,
    compileActions,
    generatedArtifacts,
  };
}

export function reflectionToSymbols(
  reflection: UClassReflection[],
  artifacts: GeneratedArtifact[],
  modules: ModuleNode[],
): UeClassSymbol[] {
  const genByHeader = new Map(artifacts.map((a) => [path.normalize(a.headerPath).toLowerCase(), a.generatedPath]));
  return reflection
    .filter((r) => r.filePath && !r.filePath.endsWith('.generated.h'))
    .map((r) => {
      const sourceFile = path.normalize(r.filePath);
      const mod = modules.find((m) => sourceFile.startsWith(path.normalize(m.root)));
      const generatedHeader = genByHeader.get(sourceFile.toLowerCase());
      const provenance: SymbolProvenance = generatedHeader ? 'generated-header' : 'source-parser';
      const confidence: SymbolConfidence = generatedHeader ? 'authoritative' : 'derived';
      const classLine = r.classLine ?? r.declarationRange?.startLine;
      const sourceLine = classLine ?? r.properties[0]?.line ?? r.functions[0]?.line ?? 0;
      return {
        id: buildStableSymbolId(mod?.name, r.className, sourceFile),
        name: r.className,
        sourceFile,
        sourceLine,
        classLine: classLine ?? sourceLine,
        declarationRange: r.declarationRange,
        baseClass: r.superClass,
        generatedHeader,
        moduleName: mod?.name,
        members: r.members,
        provenance,
        confidence,
      };
    });
}

export async function saveSemanticGraph(projectRoot: string, graph: SemanticGraph): Promise<string> {
  const dir = await ensureDataDir(projectRoot);
  const filePath = path.join(dir, SEMANTIC_GRAPH_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function loadSemanticGraph(projectRoot: string): Promise<SemanticGraph | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, SEMANTIC_GRAPH_FILE), 'utf-8');
      const graph = JSON.parse(raw) as SemanticGraph;
      if (graph.version === SEMANTIC_GRAPH_VERSION || graph.version === 1) {
        if (!graph.symbols && graph.reflection) {
          graph.symbols = reflectionToSymbols(graph.reflection, graph.generatedArtifacts ?? [], graph.modules ?? []);
        }
        return graph;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

export { resolveTargetName, discoverTargetsSync, resolveEditorTargetName, resolveGameTargetName } from '../build/targetResolver';

function parseBuildCsDeps(buildCsPath: string): { public: string[]; private: string[] } {
  try {
    const content = fs.readFileSync(buildCsPath, 'utf-8');
    const extract = (blockName: string): string[] => {
      const re = new RegExp(`${blockName}\\.AddRange\\(new string\\[\\]\\s*\\{([^}]+)\\}`, 's');
      const m = content.match(re);
      if (!m) return [];
      return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    return {
      public: extract('PublicDependencyModuleNames'),
      private: extract('PrivateDependencyModuleNames'),
    };
  } catch {
    return { public: [], private: [] };
  }
}

async function linkGeneratedArtifacts(
  project: UEProject,
  reflection: UClassReflection[],
): Promise<GeneratedArtifact[]> {
  const artifacts: GeneratedArtifact[] = [];
  const manifest = await findUhtManifest(project);
  const inputFiles = manifest ? await parseUhtManifestInputFiles(manifest) : [];

  const generatedByClass = new Map<string, string>();
  for (const cls of reflection) {
    if (!cls.filePath.endsWith('.generated.h')) continue;
    generatedByClass.set(cls.className.toLowerCase(), cls.filePath);
  }

  if (inputFiles.length > 0) {
    for (const headerPath of inputFiles) {
      if (!headerPath.endsWith('.h') || headerPath.endsWith('.generated.h')) continue;
      const className = reflection.find(
        (r) => path.normalize(r.filePath).toLowerCase() === path.normalize(headerPath).toLowerCase(),
      )?.className;
      const generated =
        (className && generatedByClass.get(className.toLowerCase())) ||
        (await findGeneratedForHeader(project.projectRoot, headerPath));
      if (generated && (await fileExists(headerPath))) {
        artifacts.push({
          headerPath: path.normalize(headerPath),
          generatedPath: path.normalize(generated),
          className,
        });
      }
    }
    if (artifacts.length > 0) return artifacts;
  }

  for (const cls of reflection) {
    if (!cls.filePath.endsWith('.generated.h')) continue;
    const headerGuess = cls.filePath.replace(/\.generated\.h$/i, '.h');
    if (await fileExists(headerGuess)) {
      artifacts.push({
        headerPath: headerGuess,
        generatedPath: cls.filePath,
        className: cls.className,
      });
    }
  }
  return artifacts;
}

async function findGeneratedForHeader(projectRoot: string, headerPath: string): Promise<string | undefined> {
  const base = path.basename(headerPath, '.h');
  const intermediate = path.join(projectRoot, 'Intermediate', 'Build');
  const matches: string[] = [];
  await walkGenerated(intermediate, `${base}.generated.h`, matches, 0);
  return matches[0];
}

async function walkGenerated(dir: string, name: string, out: string[], depth: number): Promise<void> {
  if (depth > 10) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      out.push(full);
    } else if (entry.isDirectory()) {
      await walkGenerated(full, name, out, depth + 1);
    }
  }
}

export async function collectCompileActionsFromProject(projectRoot: string): Promise<CompileAction[]> {
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  if (!(await fileExists(compileDbPath))) return [];

  try {
    const raw = JSON.parse(await fs.promises.readFile(compileDbPath, 'utf-8')) as Array<{
      file?: string;
      arguments?: string[];
      command?: string;
      directory?: string;
    }>;
    return raw
      .filter((e) => e.file)
      .map((e) => {
        const directory = e.directory ? path.resolve(e.directory) : projectRoot;
        const args = e.arguments ?? (e.command ? parseWindowsCommandLine(e.command) : []);
        const normalized = normalizeArgs(args);
        return {
          file: resolveCompilePath(e.file!, directory, projectRoot),
          arguments: args,
          hash: hashString(normalized),
          directory,
        };
      });
  } catch {
    return [];
  }
}

export async function collectCompileActions(
  ctx: UE5_8CursorContext,
  _settings: UE5_8CursorSettings,
): Promise<CompileAction[]> {
  if (!ctx.project) return [];
  return collectCompileActionsFromProject(ctx.project.projectRoot);
}

async function collectSourceFiles(dir: string, out: string[], exts: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(full, out, exts);
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
}

export async function addTranslationUnitAction(
  projectRoot: string,
  cppPath: string,
  templateAction?: CompileAction,
  options?: { enabled?: boolean; tx?: WorkspaceMutationTransaction },
): Promise<boolean> {
  if (options?.enabled === false) return false;

  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  if (!(await fileExists(compileDbPath))) return false;

  let rawContent = '';
  try {
    rawContent = await fs.promises.readFile(compileDbPath, 'utf-8');
  } catch {
    return false;
  }
  if (!rawContent.includes('UE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1')) {
    return false;
  }

  let entries: Array<{ file: string; directory?: string; arguments?: string[]; command?: string }>;
  try {
    entries = JSON.parse(rawContent);
  } catch {
    return false;
  }

  const normalized = path.normalize(cppPath);
  if (entries.some((e) => path.normalize(e.file) === normalized)) return false;

  const moduleDir = path.dirname(normalized);
  const sibling = entries.find((e) => path.dirname(path.normalize(e.file)) === moduleDir);
  const source = templateAction ?? (sibling ? { file: sibling.file, arguments: sibling.arguments ?? parseWindowsCommandLine(sibling.command ?? '') } : undefined);
  if (!source) return false;

  const args = [...(source.arguments ?? [])];
  const fileArgIndex = args.findIndex((a, i) => a.endsWith('.cpp') && i === args.length - 1);
  if (fileArgIndex >= 0) {
    args[fileArgIndex] = normalized.replace(/\\/g, '/');
  } else {
    args.push(normalized.replace(/\\/g, '/'));
  }

  entries.push({
    file: normalized.replace(/\\/g, '/'),
    directory: path.dirname(normalized).replace(/\\/g, '/'),
    arguments: args,
  });

  await mutateJson(options?.tx, projectRoot, compileDbPath, entries);
  return true;
}

export function compareActionHashes(
  expected: CompileAction[],
  actual: CompileAction[],
  options?: { mode?: 'flags' | 'tu' | 'both' },
): {
  matched: number;
  total: number;
  parity: number;
  tuLinked?: number;
  tuTotal?: number;
  tuRate?: number;
} {
  const mode = options?.mode ?? 'flags';
  const actualByFile = new Map(actual.map((a) => [canonicalCompilePath(a.file, a.directory ?? ''), a]));
  const semanticHash = (action: CompileAction): string =>
    action.arguments.length > 0 ? hashString(normalizeParityArgs(action.arguments)) : action.hash;
  let matched = 0;
  for (const exp of expected) {
    const act = actualByFile.get(canonicalCompilePath(exp.file, exp.directory ?? ''));
    if (act && semanticHash(act) === semanticHash(exp)) matched++;
  }
  const total = expected.length;
  const parity = total === 0 ? 0 : matched / total;

  let tuLinked = 0;
  if (mode === 'tu' || mode === 'both') {
    for (const exp of expected) {
      if (actualByFile.has(canonicalCompilePath(exp.file, exp.directory ?? ''))) tuLinked++;
    }
  }
  const tuTotal = expected.length;
  const tuRate = tuTotal === 0 ? 0 : tuLinked / tuTotal;

  if (mode === 'tu') {
    return { matched: tuLinked, total: tuTotal, parity: tuRate, tuLinked, tuTotal, tuRate };
  }
  if (mode === 'both') {
    return { matched, total, parity, tuLinked, tuTotal, tuRate };
  }
  return { matched, total, parity };
}
