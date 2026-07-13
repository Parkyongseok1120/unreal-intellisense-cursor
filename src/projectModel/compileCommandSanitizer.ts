import * as fs from 'fs';
import * as path from 'path';
import { parseWindowsCommandLine } from './windowsCommandLine';

export interface RawCompileDatabaseEntry {
  directory?: string;
  file?: string;
  command?: string;
  arguments?: string[];
  output?: string;
}

const MAX_RSP_DEPTH = 32;

function responsePath(argument: string, directory: string): string | undefined {
  if (!argument.startsWith('@')) return undefined;
  const raw = argument.slice(1).replace(/^"|"$/g, '');
  return path.isAbsolute(raw) ? raw : path.resolve(directory, raw);
}

function expandArguments(
  args: string[],
  directory: string,
  visited: Set<string>,
  depth: number,
): string[] {
  if (depth > MAX_RSP_DEPTH) return [];
  const expanded: string[] = [];
  for (const arg of args) {
    const rsp = responsePath(arg, directory);
    if (!rsp) {
      expanded.push(arg);
      continue;
    }
    const canonical = path.resolve(rsp).toLowerCase();
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    let content: string;
    try {
      content = fs.readFileSync(rsp, 'utf-8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    const nested: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (line.trim()) nested.push(...parseWindowsCommandLine(line.trim()));
    }
    expanded.push(...expandArguments(nested, path.dirname(rsp), visited, depth + 1));
  }
  return expanded;
}

function isSourceArgument(arg: string): boolean {
  return /\.(?:cpp|cc|cxx|c)$/i.test(arg.replace(/^"|"$/g, ''));
}

function stripBuildOnlyArguments(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\/(?:Fo|Fd|Fp|Yu|Yc)/i.test(arg)) continue;
    if (arg === '/TP' || arg === '/TC') {
      result.push(arg);
      continue;
    }
    if (/^\/T(?:c|p)$/.test(arg)) {
      i++;
      continue;
    }
    if (/^\/T(?:c|p).+/.test(arg)) continue;
    if (/^\/sourceDependencies$/i.test(arg) || arg === '-o' || arg === '--serialize-diagnostics') {
      i++;
      continue;
    }
    if (/^\/clang:-MF/i.test(arg)) continue;
    if (arg === '/clang:-MD' || arg === '-MD' || arg === '-MMD') continue;
    if (isSourceArgument(arg)) continue;
    result.push(arg);
  }
  return result;
}

/**
 * clangd cannot see source/output arguments hidden inside UBT's @obj.rsp and
 * appends the document path again. Expand the full response graph, remove
 * build-only outputs, then append exactly one canonical source argument.
 */
export function sanitizeCompileCommand(entry: RawCompileDatabaseEntry): RawCompileDatabaseEntry | undefined {
  if (!entry.file) return undefined;
  const directory = entry.directory ?? process.cwd();
  const initial = entry.arguments?.length
    ? [...entry.arguments]
    : entry.command
      ? parseWindowsCommandLine(entry.command)
      : [];
  if (initial.length === 0) return undefined;

  const driver = initial[0];
  const expanded = expandArguments(initial.slice(1), directory, new Set<string>(), 0);
  const semanticArgs = stripBuildOnlyArguments(expanded);
  const source = path.isAbsolute(entry.file) ? path.normalize(entry.file) : path.resolve(directory, entry.file);
  return {
    directory,
    file: source.replace(/\\/g, '/'),
    arguments: [driver, ...semanticArgs, source.replace(/\\/g, '/')],
  };
}

export function countSourceArguments(entry: RawCompileDatabaseEntry): number {
  return (entry.arguments ?? []).filter(isSourceArgument).length;
}
