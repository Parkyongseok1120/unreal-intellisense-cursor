import * as path from 'path';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import type { UEProject } from '../types';
import { discoverModuleLayouts } from '../parsers/moduleLayout';
import { fileExists } from '../platform/paths';
import * as fs from 'fs';

export interface ProjectModelGraph {
  projectRoot: string;
  modules: ModuleNode[];
  plugins: string[];
  targets: string[];
}

export interface ModuleNode {
  name: string;
  root: string;
  translationUnits: string[];
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
  const layouts = await discoverModuleLayouts(project.projectRoot);
  const modules: ModuleNode[] = [];

  for (const layout of layouts) {
    const tus: string[] = [];
    const privateDir = path.join(layout.moduleRoot, 'Private');
    if (await fileExists(privateDir)) {
      await collectCppFiles(privateDir, tus);
    }
    modules.push({
      name: layout.moduleName,
      root: layout.moduleRoot,
      translationUnits: tus,
    });
  }

  const plugins: string[] = [];
  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  if (await fileExists(pluginsDir)) {
    const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) plugins.push(entry.name);
    }
  }

  return {
    projectRoot: project.projectRoot,
    modules,
    plugins,
    targets: [`${project.name}Editor`, project.name],
  };
}

async function collectCppFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCppFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.cpp')) {
      out.push(full);
    }
  }
}

export async function collectCompileActions(
  ctx: UE5_8CursorContext,
  _settings: UE5_8CursorSettings,
): Promise<CompileAction[]> {
  if (!ctx.project) return [];

  const compileDbPath = path.join(ctx.project.projectRoot, 'compile_commands.json');
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

export async function addTranslationUnitAction(
  projectRoot: string,
  cppPath: string,
  templateAction?: CompileAction,
): Promise<boolean> {
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  if (!(await fileExists(compileDbPath))) return false;

  let entries: Array<{ file: string; directory?: string; arguments?: string[]; command?: string }>;
  try {
    entries = JSON.parse(await fs.promises.readFile(compileDbPath, 'utf-8'));
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

  await fs.promises.writeFile(compileDbPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
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
