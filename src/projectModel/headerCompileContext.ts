import * as fs from 'fs';
import * as path from 'path';
import { parseWindowsCommandLine, resolveCompilePath } from './windowsCommandLine';

interface CompileDbEntry {
  file?: string;
  directory?: string;
  arguments?: string[];
  command?: string;
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
  const match = relative.match(/^(.*?\/(?:Public|Private|Classes))(?:\/|$)/i);
  if (!match) return undefined;
  return path.resolve(projectRoot, path.dirname(match[1]));
}

function preferredStem(headerPath: string): string {
  return path.basename(headerPath, path.extname(headerPath)).toLowerCase();
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

  const candidates = raw.flatMap((entry) => {
    if (!entry.file) return [];
    const directory = entry.directory ?? projectRoot;
    const file = resolveCompilePath(entry.file, directory, projectRoot);
    if (!/\.(?:cpp|cc|cxx|c)$/i.test(file)) return [];
    if (!path.resolve(file).toLowerCase().startsWith(`${path.resolve(moduleRoot).toLowerCase()}${path.sep}`)) return [];
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

  const stem = preferredStem(normalizedHeader);
  const exact = candidates.find((candidate) => preferredStem(candidate.file) === stem);
  const selected = exact ?? candidates.sort((a, b) => a.file.localeCompare(b.file))[0];
  return {
    headerPath: normalizedHeader,
    translationUnit: selected.file,
    moduleRoot,
    workingDirectory: selected.directory,
    // clangd's dynamic compilation-database extension expects the current
    // document as the sole source argument. The normalizer already removed
    // build outputs and recursive RSP indirection from this command.
    compilationCommand: selected.args.map((arg) => {
      const normalizedArg = path.resolve(selected.directory, arg).toLowerCase();
      return normalizedArg === path.resolve(selected.file).toLowerCase()
        ? normalizedHeader.replace(/\\/g, '/')
        : arg;
    }),
    provenance: 'authoritative-module-tu',
    reason: exact
      ? 'Matched a same-stem authoritative translation unit.'
      : 'Selected a deterministic authoritative translation unit from the owning module.',
  };
}
