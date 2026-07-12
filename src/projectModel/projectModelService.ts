import * as path from 'path';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UEProject } from '../types';
import { discoverModuleLayouts } from '../parsers/moduleLayout';
import { fileExists } from '../platform/paths';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { buildReflectionIndex, type UClassReflection } from '../uht/reflectionIndex';
import { ensureDataDir } from '../platform/dataDir';
import * as fs from 'fs';

export const SEMANTIC_GRAPH_VERSION = 1;
const SEMANTIC_GRAPH_FILE = 'semantic-graph.json';

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

function commandToArgs(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g);
  return matches?.map((m) => m.replace(/^"|"$/g, '')) ?? [];
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
      const pluginModules = modules
        .filter((m) => m.root.includes(path.join('Plugins', entry.name)))
        .map((m) => m.name);
      plugins.push({ name: entry.name, modules: pluginModules });
    }
  }

  const targets = await discoverTargets(project.projectRoot);
  const reflection = await buildReflectionIndex(project.projectRoot);
  const compileActions = await collectCompileActionsFromProject(project.projectRoot);
  const generatedArtifacts = await linkGeneratedArtifacts(project.projectRoot, reflection);

  return {
    version: SEMANTIC_GRAPH_VERSION,
    projectRoot: project.projectRoot,
    updatedAt: new Date().toISOString(),
    generation: Date.now(),
    modules,
    plugins,
    targets,
    reflection,
    compileActions,
    generatedArtifacts,
  };
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
      if (graph.version === SEMANTIC_GRAPH_VERSION) return graph;
    } catch {
      // try next
    }
  }
  return undefined;
}

async function discoverTargets(projectRoot: string): Promise<TargetNode[]> {
  const targets: TargetNode[] = [];
  const sourceDir = path.join(projectRoot, 'Source');
  if (!(await fileExists(sourceDir))) return targets;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return targets;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.Target.cs')) continue;
    targets.push({
      name: entry.name.replace('.Target.cs', ''),
      path: path.join(sourceDir, entry.name),
    });
  }
  return targets;
}

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
  projectRoot: string,
  reflection: UClassReflection[],
): Promise<GeneratedArtifact[]> {
  const artifacts: GeneratedArtifact[] = [];
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

export async function collectCompileActionsFromProject(projectRoot: string): Promise<CompileAction[]> {
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  if (!(await fileExists(compileDbPath))) return [];

  try {
    const raw = JSON.parse(await fs.promises.readFile(compileDbPath, 'utf-8')) as Array<{
      file?: string;
      arguments?: string[];
      command?: string;
    }>;
    return raw
      .filter((e) => e.file)
      .map((e) => {
        const args = e.arguments ?? (e.command ? commandToArgs(e.command) : []);
        const normalized = normalizeArgs(args);
        return {
          file: path.normalize(e.file!),
          arguments: args,
          hash: hashString(normalized),
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
  const source = templateAction ?? (sibling ? { file: sibling.file, arguments: sibling.arguments ?? commandToArgs(sibling.command ?? '') } : undefined);
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

export function compareActionHashes(expected: CompileAction[], actual: CompileAction[]): {
  matched: number;
  total: number;
  parity: number;
} {
  const actualByFile = new Map(actual.map((a) => [path.normalize(a.file).toLowerCase(), a.hash]));
  let matched = 0;
  for (const exp of expected) {
    const hash = actualByFile.get(path.normalize(exp.file).toLowerCase());
    if (hash === exp.hash) matched++;
  }
  const total = expected.length;
  return { matched, total, parity: total === 0 ? 0 : matched / total };
}
