import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import { generateCompileDatabaseFromBuildCs } from './compileDatabaseFromBuildCs';

export interface RspCompileContext {
  projectRoot: string;
  engineRoot: string;
  engineSource: string;
  rspDir: string;
}

const ENGINE_SOURCE_PREFIXES = ['Runtime/', 'Developer/', 'Editor/', 'Programs/', 'ThirdParty/'];

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function resolveRspIncludePath(raw: string, ctx: RspCompileContext): string {
  const trimmed = raw.replace(/^"|"$/g, '').trim();
  if (!trimmed || trimmed === '.') {
    return ctx.rspDir;
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  for (const prefix of ENGINE_SOURCE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return path.join(ctx.engineSource, trimmed);
    }
  }

  const intermediateIdx = trimmed.indexOf('Intermediate');
  if (intermediateIdx >= 0) {
    return path.join(ctx.projectRoot, trimmed.slice(intermediateIdx));
  }

  const fromRsp = path.resolve(ctx.rspDir, trimmed);
  if (fs.existsSync(fromRsp)) {
    return fromRsp;
  }

  const fromEngine = path.join(ctx.engineSource, trimmed);
  if (fs.existsSync(fromEngine)) {
    return fromEngine;
  }

  return fromRsp;
}

export function convertMsvcRspLineToClangArgs(line: string, ctx: RspCompileContext): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('/errorReport')) {
    return [];
  }

  const includeMatch = trimmed.match(/^\/I\s+(.+)$/i);
  if (includeMatch) {
    const resolved = resolveRspIncludePath(includeMatch[1], ctx);
    if (normalizeSlash(resolved).endsWith('/Development/' + path.basename(ctx.rspDir)) || includeMatch[1].trim() === '.') {
      return [];
    }
    return ['-I', normalizeSlash(resolved)];
  }

  const defineMatch = trimmed.match(/^\/D([A-Za-z_].*)$/);
  if (defineMatch) {
    return [`-D${defineMatch[1]}`];
  }

  const forceIncludeMatch = trimmed.match(/^\/FI(.+)$/i);
  if (forceIncludeMatch) {
    const inc = forceIncludeMatch[1].replace(/^"|"$/g, '');
    return ['-include', normalizeSlash(path.isAbsolute(inc) ? inc : path.resolve(ctx.rspDir, inc))];
  }

  if (trimmed.match(/^\/std:c\+\+(\d+)$/i)) {
    const m = trimmed.match(/^\/std:c\+\+(\d+)$/i);
    return m ? [`-std=c++${m[1]}`] : [];
  }

  if (
    trimmed.startsWith('/Yu') ||
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
    if (args[0] === '-I' || args[0] === '-include') continue;
    for (const flag of args) {
      if (seen.has(flag)) continue;
      seen.add(flag);
      flags.push(flag);
    }
  }

  // Re-parse paired -I / -include (dedupe by path only)
  for (const line of content.split(/\r?\n/)) {
    const paired = convertMsvcRspLineToClangArgs(line, ctx);
    if (paired.length === 2 && (paired[0] === '-I' || paired[0] === '-include')) {
      const key = `${paired[0]}:${paired[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push(paired[0], paired[1]);
    }
  }

  return flags;
}

function parseObjRspForceIncludes(objRspPath: string, ctx: RspCompileContext): string[] {
  const flags: string[] = [];
  try {
    const content = fs.readFileSync(objRspPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const paired = convertMsvcRspLineToClangArgs(line.trim(), ctx);
      if (paired.length === 2 && paired[0] === '-include') {
        flags.push(paired[0], paired[1]);
      }
    }
  } catch {
    // ignore
  }
  return flags;
}

async function findObjRspNear(sharedRsp: string): Promise<string | undefined> {
  const dir = path.dirname(sharedRsp);
  try {
    const entries = await fs.promises.readdir(dir);
    const hit = entries.find((e) => e.startsWith('Module.') && e.endsWith('.cpp.obj.rsp'));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

export async function findSharedRspFiles(projectRoot: string): Promise<string[]> {
  const base = path.join(projectRoot, 'Intermediate', 'Build');
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.Shared.rsp')) {
        results.push(full);
      } else if (entry.isDirectory()) {
        await walk(full, depth - 1);
      }
    }
  }

  await walk(base, 10);
  return results;
}

async function collectCppFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const roots = [path.join(projectRoot, 'Source'), path.join(projectRoot, 'Plugins')];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'Intermediate' || entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.isFile() && /\.(cpp|cc|cxx)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }
  return files;
}

function moduleNameFromRsp(rspPath: string): string {
  return path.basename(rspPath, '.Shared.rsp');
}

export async function generateCompileDatabaseFromRsp(
  projectRoot: string,
  engineRoot: string,
): Promise<{ ok: boolean; entryCount: number; rspPath?: string; error?: string }> {
  const rspFiles = await findSharedRspFiles(projectRoot);
  if (rspFiles.length === 0) {
    return {
      ok: false,
      entryCount: 0,
      error: 'Intermediate에 .Shared.rsp가 없습니다. UE 에디터에서 프로젝트를 한 번 빌드하세요.',
    };
  }

  const cppFiles = await collectCppFiles(projectRoot);
  if (cppFiles.length === 0) {
    return { ok: false, entryCount: 0, error: 'Source/*.cpp 파일을 찾지 못했습니다.' };
  }

  const entries: Array<{ directory: string; file: string; command: string }> = [];
  const compiler = 'clang++';

  for (const rspPath of rspFiles) {
    const moduleName = moduleNameFromRsp(rspPath);
    const ctx: RspCompileContext = {
      projectRoot,
      engineRoot,
      engineSource: path.join(engineRoot, 'Engine', 'Source'),
      rspDir: path.dirname(rspPath),
    };
    let flags = parseSharedRspToClangFlags(rspPath, engineRoot, projectRoot);
    const objRsp = await findObjRspNear(rspPath);
    if (objRsp) {
      const seen = new Set<string>();
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '-I' || flags[i] === '-include') seen.add(`${flags[i]}:${flags[i + 1]}`);
      }
      const extras = parseObjRspForceIncludes(objRsp, ctx);
      for (let j = 0; j < extras.length; j += 2) {
        const key = `${extras[j]}:${extras[j + 1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          flags.push(extras[j], extras[j + 1]);
        }
      }
    }
    const flagParts: string[] = [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === '-I' || f === '-include') {
        flagParts.push(`${f} "${flags[++i]}"`);
      } else {
        flagParts.push(f.includes(' ') ? `"${f}"` : f);
      }
    }
    const flagStr = flagParts.join(' ');
    const moduleCpp = cppFiles.filter((f) => {
      const norm = normalizeSlash(f);
      return norm.includes(`/Source/${moduleName}/`) || norm.includes(`/Plugins/`) && norm.includes(`/${moduleName}/`);
    });

    const targets = moduleCpp.length > 0 ? moduleCpp : cppFiles;
    for (const file of targets) {
      const directory = projectRoot;
      const command = `${compiler} ${flagStr} -c ${normalizeSlash(file)}`;
      entries.push({
        directory: normalizeSlash(directory),
        file: normalizeSlash(file),
        command,
      });
    }
  }

  if (entries.length === 0) {
    return { ok: false, entryCount: 0, error: 'compile_commands 항목을 만들지 못했습니다.' };
  }

  const outPath = path.join(projectRoot, 'compile_commands.json');
  await fs.promises.writeFile(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  return { ok: true, entryCount: entries.length, rspPath: rspFiles[0] };
}

export async function tryGenerateCompileDatabase(
  projectRoot: string,
  engineRoot: string,
): Promise<{ ok: boolean; source: 'rsp' | 'ubt' | 'buildcs'; entryCount?: number; error?: string }> {
  if (!(await fileExists(engineRoot))) {
    return { ok: false, source: 'rsp', error: `엔진 경로 없음: ${engineRoot}` };
  }
  const rsp = await generateCompileDatabaseFromRsp(projectRoot, engineRoot);
  if (rsp.ok) {
    return { ok: true, source: 'rsp', entryCount: rsp.entryCount };
  }
  const buildcs = await generateCompileDatabaseFromBuildCs(projectRoot, engineRoot);
  if (buildcs.ok) {
    return { ok: true, source: 'buildcs', entryCount: buildcs.entryCount };
  }
  return { ok: false, source: 'buildcs', error: rsp.error ?? buildcs.error };
}
