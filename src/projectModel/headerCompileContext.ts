import * as fs from 'fs';
import * as path from 'path';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import { parseWindowsCommandLine, resolveCompilePath } from './windowsCommandLine';

interface CompileDbEntry {
  file?: string;
  directory?: string;
  arguments?: string[];
  command?: string;
}

interface ModuleCandidate {
  file: string;
  directory: string;
  args: string[];
}

export interface HeaderCompileContext {
  headerPath: string;
  translationUnit?: string;
  moduleRoot?: string;
  workingDirectory?: string;
  compilationCommand?: string[];
  provenance: 'authoritative-module-tu' | 'provisional';
  reason: string;
}

function moduleRootForPath(projectRoot: string, filePath: string): string | undefined {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const sectionMatch = relative.match(/^(.*?\/(?:Public|Private|Classes))(?:\/|$)/i);
  if (sectionMatch) {
    return path.resolve(projectRoot, path.dirname(sectionMatch[1]));
  }
  const flatMatch = relative.match(/^(?:Plugins\/.+\/Source|Source)\/([^/]+)\//i);
  if (flatMatch) {
    const prefix = relative.startsWith('Plugins/') ? `Plugins/${relative.split('/')[1]}/Source` : 'Source';
    return path.resolve(projectRoot, prefix, flatMatch[1]);
  }
  return undefined;
}

function preferredStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function tuIncludesHeader(tuPath: string, headerBasename: string): boolean {
  try {
    const content = fs.readFileSync(tuPath, 'utf-8');
    const pattern = new RegExp(`#include\\s+["<]${escapeRegex(headerBasename)}[">]`, 'm');
    return pattern.test(content);
  } catch {
    return false;
  }
}

function selectTranslationUnit(
  candidates: ModuleCandidate[],
  headerPath: string,
): { selected?: ModuleCandidate; reason: string } {
  const stem = preferredStem(headerPath);
  const exact = candidates.find((candidate) => preferredStem(candidate.file) === stem);
  if (exact) {
    return { selected: exact, reason: 'Matched a same-stem authoritative translation unit.' };
  }

  const headerBasename = path.basename(headerPath);
  const includeMatch = candidates.find((candidate) => tuIncludesHeader(candidate.file, headerBasename));
  if (includeMatch) {
    return { selected: includeMatch, reason: 'Matched a translation unit that includes this header.' };
  }

  const paired = findPairedSourceFile(headerPath);
  if (paired) {
    const pairedResolved = path.resolve(paired).toLowerCase();
    const pairedCandidate = candidates.find((candidate) => path.resolve(candidate.file).toLowerCase() === pairedResolved);
    if (pairedCandidate) {
      return { selected: pairedCandidate, reason: 'Matched the paired translation unit for this header.' };
    }
  }

  return { reason: 'No translation unit confidently matches this header.' };
}

/**
 * This resolver finds the exact module action for clangd's dynamic
 * compilation-database API and never silently labels a header authoritative
 * when no module action exists.
 */
export async function resolveHeaderCompileContext(
  projectRoot: string,
  headerPath: string,
): Promise<HeaderCompileContext> {
  const normalizedHeader = path.resolve(headerPath);
  const moduleRoot = moduleRootForPath(projectRoot, normalizedHeader);
  if (!moduleRoot) {
    return {
      headerPath: normalizedHeader,
      provenance: 'provisional',
      reason: 'Header is outside a UE module Public/Private/Classes root.',
    };
  }

  let raw: CompileDbEntry[];
  try {
    raw = JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'compile_commands.json'), 'utf-8')) as CompileDbEntry[];
  } catch {
    return {
      headerPath: normalizedHeader,
      moduleRoot,
      provenance: 'provisional',
      reason: 'compile_commands.json is missing or invalid.',
    };
  }

  const modulePrefix = `${path.resolve(moduleRoot).toLowerCase()}${path.sep}`;
  const candidates = raw.flatMap((entry) => {
    if (!entry.file) return [];
    const directory = entry.directory ?? projectRoot;
    const file = resolveCompilePath(entry.file, directory, projectRoot);
    if (!/\.(?:cpp|cc|cxx|c)$/i.test(file)) return [];
    if (!path.resolve(file).toLowerCase().startsWith(modulePrefix)) return [];
    const args = entry.arguments ?? (entry.command ? parseWindowsCommandLine(entry.command) : []);
    return [{ file, directory, args }];
  });
  if (candidates.length === 0) {
    return {
      headerPath: normalizedHeader,
      moduleRoot,
      provenance: 'provisional',
      reason: 'No authoritative translation-unit action exists for this module.',
    };
  }

  const { selected, reason } = selectTranslationUnit(candidates, normalizedHeader);
  if (!selected) {
    return {
      headerPath: normalizedHeader,
      moduleRoot,
      provenance: 'provisional',
      reason,
    };
  }

  return {
    headerPath: normalizedHeader,
    translationUnit: selected.file,
    moduleRoot,
    workingDirectory: selected.directory,
    compilationCommand: selected.args.map((arg) => {
      const normalizedArg = path.resolve(selected.directory, arg).toLowerCase();
      return normalizedArg === path.resolve(selected.file).toLowerCase()
        ? normalizedHeader.replace(/\\/g, '/')
        : arg;
    }),
    provenance: 'authoritative-module-tu',
    reason,
  };
}
