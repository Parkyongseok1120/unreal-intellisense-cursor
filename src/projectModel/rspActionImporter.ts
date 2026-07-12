import * as fs from 'fs';
import * as path from 'path';
import type { CompileAction } from './projectModelService';
import type { SnapshotKeyParts } from './snapshotKey';
import { rspPathMatchesKey } from './snapshotKey';
import { canonicalCompilePath, parseWindowsCommandLine } from './windowsCommandLine';

export interface RspCompileContext {
  projectRoot: string;
  engineRoot: string;
  engineSource: string;
  rspDir: string;
}

const ENGINE_SOURCE_PREFIXES = ['Runtime/', 'Developer/', 'Editor/', 'Programs/', 'ThirdParty/'];
const MAX_RSP_DEPTH = 32;

export function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function canonicalTuPath(filePath: string, projectRoot: string): string {
  return canonicalCompilePath(filePath, projectRoot);
}

export function resolveRspIncludePath(raw: string, ctx: RspCompileContext): string {
  const trimmed = raw.replace(/^"|"$/g, '').trim();
  if (!trimmed || trimmed === '.') return ctx.rspDir;
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);

  for (const prefix of ENGINE_SOURCE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return path.join(ctx.engineSource, trimmed);
  }

  const intermediateIdx = trimmed.indexOf('Intermediate');
  if (intermediateIdx >= 0) return path.join(ctx.projectRoot, trimmed.slice(intermediateIdx));

  const fromRsp = path.resolve(ctx.rspDir, trimmed);
  if (fs.existsSync(fromRsp)) return fromRsp;

  const fromEngine = path.join(ctx.engineSource, trimmed);
  if (fs.existsSync(fromEngine)) return fromEngine;

  return fromRsp;
}

export function convertMsvcRspLineToClangArgs(line: string, ctx: RspCompileContext): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('/errorReport')) return [];

  const includeMatch = trimmed.match(/^\/I\s+(.+)$/i);
  if (includeMatch) {
    const resolved = resolveRspIncludePath(includeMatch[1], ctx);
    if (
      normalizeSlash(resolved).endsWith('/Development/' + path.basename(ctx.rspDir)) ||
      includeMatch[1].trim() === '.'
    ) {
      return [];
    }
    return ['-I', normalizeSlash(resolved)];
  }

  const defineMatch = trimmed.match(/^\/D([A-Za-z_].*)$/);
  if (defineMatch) return [`-D${defineMatch[1]}`];

  const forceIncludeMatch = trimmed.match(/^\/FI(.+)$/i);
  if (forceIncludeMatch) {
    const inc = forceIncludeMatch[1].replace(/^"|"$/g, '');
    return ['-include', normalizeSlash(path.isAbsolute(inc) ? inc : path.resolve(ctx.rspDir, inc))];
  }

  const pchUseMatch = trimmed.match(/^\/Yu(.+)$/i);
  if (pchUseMatch) {
    const inc = pchUseMatch[1].replace(/^"|"$/g, '');
    return ['-include-pch', normalizeSlash(path.isAbsolute(inc) ? inc : path.resolve(ctx.rspDir, inc))];
  }

  if (trimmed.match(/^\/std:c\+\+(\d+)$/i)) {
    const m = trimmed.match(/^\/std:c\+\+(\d+)$/i);
    return m ? [`-std=c++${m[1]}`] : [];
  }

  if (
    trimmed.startsWith('/Fp') ||
    trimmed.startsWith('/Fo') ||
    trimmed.startsWith('/nologo') ||
    trimmed.startsWith('/TP') ||
    trimmed.startsWith('/GR') ||
    trimmed.startsWith('/wd') ||
    trimmed.startsWith('/we') ||
    trimmed.startsWith('/W') ||
    trimmed.startsWith('/O') ||
    trimmed.startsWith('/Ob') ||
    trimmed.startsWith('/Ox') ||
    trimmed.startsWith('/Ot') ||
    trimmed.startsWith('/GF') ||
    trimmed.startsWith('/Gy') ||
    trimmed.startsWith('/Gw') ||
    trimmed.startsWith('/MD') ||
    trimmed.startsWith('/Z') ||
    trimmed.startsWith('/EH') ||
    trimmed.startsWith('/FC') ||
    trimmed.startsWith('/c') ||
    trimmed.startsWith('/bigobj') ||
    trimmed.startsWith('/fp:') ||
    trimmed.startsWith('/permissive') ||
    trimmed.startsWith('/experimental:') ||
    trimmed.startsWith('/sourceDependencies') ||
    trimmed.startsWith('/d2') ||
    trimmed.startsWith('/dx') ||
    trimmed === '/X'
  ) {
    return [];
  }

  return [];
}

export function parseSharedRspToClangFlags(rspPath: string, engineRoot: string, projectRoot: string): string[] {
  const content = fs.readFileSync(rspPath, 'utf-8');
  const ctx: RspCompileContext = {
    projectRoot,
    engineRoot,
    engineSource: path.join(engineRoot, 'Engine', 'Source'),
    rspDir: path.dirname(rspPath),
  };

  const flags: string[] = ['-std=c++20', '-fms-compatibility', '-fms-extensions', '-Wno-unknown-pragmas'];
  const seen = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const args = convertMsvcRspLineToClangArgs(line, ctx);
    if (args[0] === '-I' || args[0] === '-include' || args[0] === '-include-pch') continue;
    for (const flag of args) {
      if (seen.has(flag)) continue;
      seen.add(flag);
      flags.push(flag);
    }
  }

  for (const line of content.split(/\r?\n/)) {
    const paired = convertMsvcRspLineToClangArgs(line, ctx);
    if (
      paired.length === 2 &&
      (paired[0] === '-I' || paired[0] === '-include' || paired[0] === '-include-pch')
    ) {
      const key = `${paired[0]}:${paired[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push(paired[0], paired[1]);
    }
  }

  return flags;
}

export function parseObjRspForceIncludes(objRspPath: string, ctx: RspCompileContext): string[] {
  const flags: string[] = [];
  try {
    const content = fs.readFileSync(objRspPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const paired = convertMsvcRspLineToClangArgs(line.trim(), ctx);
      if (
        paired.length === 2 &&
        (paired[0] === '-include' || paired[0] === '-include-pch' || paired[0] === '-I')
      ) {
        flags.push(paired[0], paired[1]);
      }
    }
  } catch {
    // ignore
  }
  return flags;
}

function parseRspLineTokens(line: string): string[] {
  return parseWindowsCommandLine(line);
}

export function expandRspFile(
  rspPath: string,
  ctx: RspCompileContext,
  visited: Set<string>,
  depth: number,
): string[] {
  const canonical = path.resolve(rspPath);
  if (visited.has(canonical) || depth > MAX_RSP_DEPTH) return [];
  visited.add(canonical);

  let content: string;
  try {
    content = fs.readFileSync(canonical, 'utf-8');
  } catch {
    return [];
  }

  const args: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@')) {
      const nested = trimmed.slice(1).trim().replace(/^"|"$/g, '');
      const nestedPath = path.isAbsolute(nested) ? nested : path.resolve(path.dirname(canonical), nested);
      args.push(...expandRspFile(nestedPath, ctx, visited, depth + 1));
      continue;
    }
    args.push(...parseRspLineTokens(trimmed));
  }
  return args;
}

export function normalizeParityArgs(args: string[]): string {
  return args
    .map((a) => a.replace(/\\/g, '/'))
    .filter((a) => {
      if (!a.length) return false;
      if (/^(?:cl(?:\.exe)?|clang\+\+(?:\.exe)?|clang(?:\.exe)?)$/i.test(path.basename(a))) return false;
      if (/\.(?:cpp|c|cc|cxx)$/i.test(a) && !a.startsWith('-')) return false;
      if (a === '/c' || a === '-c') return false;
      if (a.startsWith('/Fo') || a.startsWith('-Fo')) return false;
      if (a.endsWith('.obj') || a.endsWith('.o')) return false;
      if (a.startsWith('/sourceDependencies')) return false;
      return true;
    })
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

function extractSourceFromObjRsp(objRspPath: string, rawLines: string[], projectRoot: string): string | undefined {
  for (const line of rawLines) {
    const tcMatch = line.trim().match(/^\/Tc(.+)$/i);
    if (tcMatch) return canonicalTuPath(tcMatch[1].replace(/^"|"$/g, ''), projectRoot);
    const tokens = parseRspLineTokens(line);
    for (const token of tokens) {
      if (/\.(cpp|c|cc|cxx)$/i.test(token) && !token.startsWith('/Fo')) {
        return canonicalTuPath(token.replace(/^"|"$/g, ''), projectRoot);
      }
    }
  }

  const base = path.basename(objRspPath);
  const moduleMatch = base.match(/^Module\.(.+)\.cpp\.obj\.rsp$/i);
  if (moduleMatch) {
    const moduleName = moduleMatch[1];
    const candidates = [
      path.join(projectRoot, 'Source', moduleName, 'Private'),
      path.join(projectRoot, 'Source', moduleName),
      path.join(projectRoot, 'Plugins'),
    ];
    for (const dir of candidates) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.(cpp|cc|cxx)$/i.test(entry.name)) continue;
          if (entry.name.toLowerCase().includes(moduleName.toLowerCase())) {
            return canonicalTuPath(path.join(dir, entry.name), projectRoot);
          }
        }
      } catch {
        // optional
      }
    }
  }
  return undefined;
}

export async function collectRspPaths(projectRoot: string, key?: SnapshotKeyParts): Promise<string[]> {
  const buildDir = path.join(projectRoot, 'Intermediate', 'Build');
  const rspFiles: string[] = [];
  await walkRsp(buildDir, rspFiles, 0);
  if (!key) return rspFiles;
  return rspFiles.filter((p) => rspPathMatchesKey(p, projectRoot, key));
}

async function walkRsp(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 14) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRsp(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.rsp')) {
      out.push(full);
    }
  }
}

export async function findSharedRspFiles(projectRoot: string, key?: SnapshotKeyParts): Promise<string[]> {
  const all = await collectRspPaths(projectRoot, key);
  return all.filter((p) => p.endsWith('.Shared.rsp'));
}

export async function findObjRspFiles(projectRoot: string, key?: SnapshotKeyParts): Promise<string[]> {
  const all = await collectRspPaths(projectRoot, key);
  return all.filter((p) => p.endsWith('.cpp.obj.rsp'));
}

export async function importAuthoritativeActionsFromRsp(
  projectRoot: string,
  engineRoot: string,
  key?: SnapshotKeyParts,
): Promise<CompileAction[]> {
  const objRsps = await findObjRspFiles(projectRoot, key);
  const actions: CompileAction[] = [];
  const seen = new Set<string>();

  for (const objRspPath of objRsps) {
    try {
      const raw = await fs.promises.readFile(objRspPath, 'utf-8');
      const rawLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const sourceFile = extractSourceFromObjRsp(objRspPath, rawLines, projectRoot);
      if (!sourceFile) continue;

      const rspDir = path.dirname(objRspPath);
      const ctx: RspCompileContext = {
        projectRoot,
        engineRoot,
        engineSource: path.join(engineRoot, 'Engine', 'Source'),
        rspDir,
      };

      const visited = new Set<string>();
      const msvcArgs: string[] = [];
      for (const line of rawLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('@')) {
          const nested = trimmed.slice(1).trim().replace(/^"|"$/g, '');
          const nestedPath = path.isAbsolute(nested) ? nested : path.resolve(rspDir, nested);
          msvcArgs.push(...expandRspFile(nestedPath, ctx, visited, 0));
        } else {
          msvcArgs.push(...parseRspLineTokens(trimmed));
        }
      }

      let clangArgs = ['-std=c++20', '-fms-compatibility', '-fms-extensions', '-Wno-unknown-pragmas'];
      const sharedRsp = rawLines
        .map((l) => l.trim())
        .find((l) => l.startsWith('@') && l.toLowerCase().includes('.shared.rsp'));
      if (sharedRsp) {
        const nested = sharedRsp.slice(1).trim().replace(/^"|"$/g, '');
        const sharedPath = path.isAbsolute(nested) ? nested : path.resolve(rspDir, nested);
        if (fs.existsSync(sharedPath)) {
          clangArgs = parseSharedRspToClangFlags(sharedPath, engineRoot, projectRoot);
        }
      }

      const extras = parseObjRspForceIncludes(objRspPath, ctx);
      for (let i = 0; i < extras.length; i += 2) {
        clangArgs.push(extras[i], extras[i + 1]);
      }

      for (const arg of msvcArgs) {
        const paired = convertMsvcRspLineToClangArgs(arg, ctx);
        if (paired.length === 2) clangArgs.push(paired[0], paired[1]);
        else if (paired.length === 1) clangArgs.push(paired[0]);
      }

      const keyPath = canonicalTuPath(sourceFile, projectRoot);
      if (seen.has(keyPath)) continue;
      seen.add(keyPath);

      const normalized = normalizeParityArgs(clangArgs);
      actions.push({
        file: keyPath,
        arguments: clangArgs,
        hash: hashString(normalized),
        directory: projectRoot,
        targetKey: key?.snapshotKey,
        synthetic: false,
      });
    } catch {
      // skip broken obj rsp
    }
  }

  if (actions.length > 0) return actions;

  return importActionsFromLegacySharedRsp(projectRoot, engineRoot, key);
}

async function importActionsFromLegacySharedRsp(
  projectRoot: string,
  engineRoot: string,
  key?: SnapshotKeyParts,
): Promise<CompileAction[]> {
  const sharedRsps = await findSharedRspFiles(projectRoot, key);
  const actions: CompileAction[] = [];
  const seen = new Set<string>();

  for (const rspPath of sharedRsps) {
    const flags = parseSharedRspToClangFlags(rspPath, engineRoot, projectRoot);
    const ctx: RspCompileContext = {
      projectRoot,
      engineRoot,
      engineSource: path.join(engineRoot, 'Engine', 'Source'),
      rspDir: path.dirname(rspPath),
    };
    const visited = new Set<string>();
    const expanded = expandRspFile(rspPath, ctx, visited, 0);
    const cpp = expanded.find((a) => /\.(cpp|c|cc|cxx)$/i.test(a) && !a.startsWith('/Fo'));
    if (!cpp) continue;
    const keyPath = canonicalTuPath(cpp, projectRoot);
    if (seen.has(keyPath)) continue;
    seen.add(keyPath);
    actions.push({
      file: keyPath,
      arguments: flags,
      hash: hashString(normalizeParityArgs(flags)),
      directory: projectRoot,
      targetKey: key?.snapshotKey,
      synthetic: false,
    });
  }
  return actions;
}

/** @deprecated use importAuthoritativeActionsFromRsp */
export async function importActionsFromRsp(
  projectRoot: string,
  engineRoot = projectRoot,
  key?: SnapshotKeyParts,
): Promise<CompileAction[]> {
  return importAuthoritativeActionsFromRsp(projectRoot, engineRoot, key);
}
