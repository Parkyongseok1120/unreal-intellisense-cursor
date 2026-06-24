import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import { discoverModuleIncludePaths } from './uhtIntellisense';

const ENGINE_SEARCH_ROOTS = ['Runtime', 'Developer', 'Editor', 'Programs'] as const;

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function parseBuildCsDependencies(buildCsPath: string): { public: string[]; private: string[] } {
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
}

async function findBuildCsFiles(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
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
        if (entry.name === 'Intermediate') continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.Build.cs')) {
        results.push(full);
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }
  return results;
}

async function resolveEngineModulePublic(engineSource: string, moduleName: string): Promise<string | undefined> {
  for (const root of ENGINE_SEARCH_ROOTS) {
    const base = path.join(engineSource, root);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== moduleName) continue;
      const publicDir = path.join(base, entry.name, 'Public');
      if (await fileExists(publicDir)) return publicDir;
      const classesDir = path.join(base, entry.name, 'Classes');
      if (await fileExists(classesDir)) return classesDir;
    }
  }

  // Plugins under engine
  const enginePlugins = path.join(path.dirname(engineSource), 'Plugins');
  async function walkPlugins(dir: string, depth: number): Promise<string | undefined> {
    if (depth <= 0) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === moduleName) {
          const pub = path.join(full, 'Source', moduleName, 'Public');
          if (await fileExists(pub)) return pub;
        }
        const found = await walkPlugins(full, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  return walkPlugins(enginePlugins, 4);
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
        if (entry.name === 'Intermediate') continue;
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

async function scanIntermediateInc(projectRoot: string): Promise<string[]> {
  const results = new Set<string>();
  const base = path.join(projectRoot, 'Intermediate', 'Build');
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
      if (entry.isDirectory()) {
        if (entry.name === 'Inc' || entry.name === 'UHT') results.add(full);
        await walk(full, depth - 1);
      }
    }
  }
  await walk(base, 8);
  return [...results];
}

function flagsToCommand(flags: string[], file: string): string {
  const parts: string[] = ['clang++'];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === '-I' || f === '-include') {
      parts.push(`${f} "${flags[++i]}"`);
    } else {
      parts.push(f.includes(' ') ? `"${f}"` : f);
    }
  }
  parts.push('-c', normalizeSlash(file));
  return parts.join(' ');
}

export async function generateCompileDatabaseFromBuildCs(
  projectRoot: string,
  engineRoot: string,
): Promise<{ ok: boolean; entryCount: number; error?: string }> {
  if (!(await fileExists(engineRoot))) {
    return { ok: false, entryCount: 0, error: `엔진 경로 없음: ${engineRoot}` };
  }

  const engineSource = path.join(engineRoot, 'Engine', 'Source');
  const includeSet = new Set<string>();
  const defines = [
    '-std=c++20',
    '-fms-compatibility',
    '-fms-extensions',
    '-Wno-unknown-pragmas',
    '-DUE_BUILD_DEVELOPMENT=1',
    '-DWITH_EDITOR=1',
    '-DPLATFORM_WINDOWS=1',
    '-DUE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1',
  ];

  for (const inc of await discoverModuleIncludePaths(projectRoot)) {
    includeSet.add(inc);
  }
  for (const inc of await scanIntermediateInc(projectRoot)) {
    includeSet.add(inc);
  }

  const buildCsFiles = await findBuildCsFiles(projectRoot);
  const moduleNames = new Set<string>();
  for (const bc of buildCsFiles) {
    const deps = parseBuildCsDependencies(bc);
    for (const m of [...deps.public, ...deps.private]) moduleNames.add(m);
  }

  for (const mod of moduleNames) {
    const resolved = await resolveEngineModulePublic(engineSource, mod);
    if (resolved) includeSet.add(resolved);
  }

  // Core modules always needed
  for (const core of ['Core', 'CoreUObject', 'Engine', 'InputCore']) {
    const resolved = await resolveEngineModulePublic(engineSource, core);
    if (resolved) includeSet.add(resolved);
  }

  const flags: string[] = [...defines];
  for (const inc of includeSet) {
    flags.push('-I', normalizeSlash(inc));
  }

  const cppFiles = await collectCppFiles(projectRoot);
  if (cppFiles.length === 0) {
    return { ok: false, entryCount: 0, error: 'Source/*.cpp 없음' };
  }

  const entries = cppFiles.map((file) => ({
    directory: normalizeSlash(projectRoot),
    file: normalizeSlash(file),
    command: flagsToCommand(flags, file),
  }));

  await fs.promises.writeFile(
    path.join(projectRoot, 'compile_commands.json'),
    JSON.stringify(entries, null, 2) + '\n',
    'utf-8',
  );
  return { ok: true, entryCount: entries.length };
}
