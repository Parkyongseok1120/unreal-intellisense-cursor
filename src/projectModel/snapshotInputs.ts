import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findUhtManifest } from '../uht/uhtRunner';
import type { UEInstallation, UEProject } from '../types';
import type { InputFingerprint } from './buildSnapshot';
import { collectRspPaths } from './rspActionImporter';
import { readEngineBuildId, readToolchainId, readUbtToolchainId } from './snapshotKey';

export const FINGERPRINT_SKIP_DIRS = new Set([
  '.git',
  '.ue5_8cursor',
  '.ue58rider',
  'Binaries',
  'DerivedDataCache',
  'Intermediate',
  'Saved',
  'node_modules',
]);

const MTIME_CACHE_FILE = 'input-mtime-cache.json';

interface MtimeCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface CollectInputsOptions {
  projectRoot: string;
  project?: UEProject;
  engine?: UEInstallation;
  engineRoot?: string;
}

async function fingerprintFile(filePath: string): Promise<InputFingerprint | undefined> {
  try {
    const raw = await fs.promises.readFile(filePath);
    return {
      path: filePath,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    };
  } catch {
    return undefined;
  }
}

async function walkFingerprint(
  dir: string,
  pattern: RegExp,
  out: InputFingerprint[],
  depth: number,
): Promise<void> {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (FINGERPRINT_SKIP_DIRS.has(entry.name)) continue;
      await walkFingerprint(full, pattern, out, depth + 1);
    } else if (pattern.test(entry.name)) {
      const fp = await fingerprintFile(full);
      if (fp) out.push(fp);
    }
  }
}

async function loadMtimeCache(projectRoot: string): Promise<Map<string, MtimeCacheEntry>> {
  const cachePath = path.join(projectRoot, '.ue5_8cursor', MTIME_CACHE_FILE);
  try {
    const raw = await fs.promises.readFile(cachePath, 'utf-8');
    const entries = JSON.parse(raw) as MtimeCacheEntry[];
    return new Map(entries.map((e) => [e.path, e]));
  } catch {
    return new Map();
  }
}

async function saveMtimeCache(projectRoot: string, entries: MtimeCacheEntry[]): Promise<void> {
  const dir = path.join(projectRoot, '.ue5_8cursor');
  await fs.promises.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, MTIME_CACHE_FILE);
  const tmp = `${cachePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  await fs.promises.rename(tmp, cachePath);
}

async function fingerprintWithMtimeCache(
  filePath: string,
  cache: Map<string, MtimeCacheEntry>,
  outEntries: MtimeCacheEntry[],
): Promise<InputFingerprint | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      outEntries.push(cached);
      return { path: filePath, sha256: cached.sha256 };
    }
    const fp = await fingerprintFile(filePath);
    if (!fp) return undefined;
    outEntries.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, sha256: fp.sha256 });
    return fp;
  } catch {
    return undefined;
  }
}

function buildInventoryMerkle(projectRoot: string, inputs: InputFingerprint[]): string {
  const inventory = inputs
    .filter((input) => !input.path.startsWith('__'))
    .map((input) => `${path.relative(projectRoot, input.path).replace(/\\/g, '/')}\0${input.sha256}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(inventory).digest('hex');
}

export async function collectInputFingerprints(options: CollectInputsOptions): Promise<{
  inputs: InputFingerprint[];
  uhtManifestPath?: string;
  engineBuildId?: string;
  ubtVersion?: string;
  toolchainId?: string;
}> {
  const { projectRoot, project, engine, engineRoot } = options;
  const inputs: InputFingerprint[] = [];
  const mtimeEntries: MtimeCacheEntry[] = [];
  const cache = await loadMtimeCache(projectRoot);

  const uproject = (await fs.promises.readdir(projectRoot)).find((f) => f.endsWith('.uproject'));
  if (uproject) {
    const fp = await fingerprintWithMtimeCache(path.join(projectRoot, uproject), cache, mtimeEntries);
    if (fp) inputs.push(fp);
  }

  const compileDb = await fingerprintWithMtimeCache(path.join(projectRoot, 'compile_commands.json'), cache, mtimeEntries);
  if (compileDb) inputs.push(compileDb);

  const buildConfigCandidates = [
    path.join(projectRoot, 'Config', 'BuildConfiguration.xml'),
    engineRoot && path.join(engineRoot, 'Engine', 'Saved', 'UnrealBuildTool', 'BuildConfiguration.xml'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'UnrealBuildTool', 'BuildConfiguration.xml'),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of buildConfigCandidates) {
    const buildConfig = await fingerprintWithMtimeCache(candidate, cache, mtimeEntries);
    if (buildConfig) inputs.push(buildConfig);
  }

  if (engineRoot) {
    const engineConfig = await fingerprintWithMtimeCache(
      path.join(engineRoot, 'Engine', 'Config', 'BaseEngine.ini'),
      cache,
      mtimeEntries,
    );
    if (engineConfig) inputs.push(engineConfig);
  }

  await walkFingerprint(projectRoot, /\.(Build|Target)\.cs$/i, inputs, 0);
  await walkFingerprint(projectRoot, /\.uplugin$/i, inputs, 0);

  let uhtManifestPath: string | undefined;
  if (project) {
    uhtManifestPath = await findUhtManifest(project);
    if (uhtManifestPath) {
      const fp = await fingerprintWithMtimeCache(uhtManifestPath, cache, mtimeEntries);
      if (fp) inputs.push(fp);
    }
  }

  const engineBuildId = await readEngineBuildId(engineRoot ?? engine?.root);
  if (engineBuildId) {
    inputs.push({ path: '__engine_build_id__', sha256: crypto.createHash('sha256').update(engineBuildId).digest('hex') });
  }

  const ubtVersion = await readUbtToolchainId(engine);
  if (ubtVersion) {
    inputs.push({ path: '__ubt_version__', sha256: crypto.createHash('sha256').update(ubtVersion).digest('hex') });
  }
  const toolchainId = await readToolchainId(engine);
  if (toolchainId) {
    inputs.push({ path: '__toolchain_id__', sha256: crypto.createHash('sha256').update(toolchainId).digest('hex') });
  }

  const rspPaths = await collectRspPaths(projectRoot);
  const rspHashes: string[] = [];
  for (const rsp of rspPaths.sort()) {
    const fp = await fingerprintWithMtimeCache(rsp, cache, mtimeEntries);
    if (fp) rspHashes.push(`${path.relative(projectRoot, rsp).replace(/\\/g, '/')}\0${fp.sha256}`);
  }
  if (rspHashes.length > 0) {
    inputs.push({
      path: '__rsp_merkle__',
      sha256: crypto.createHash('sha256').update(rspHashes.join('\n')).digest('hex'),
    });
  }

  inputs.push({
    path: '__project_input_inventory__',
    sha256: buildInventoryMerkle(projectRoot, inputs),
  });

  await saveMtimeCache(projectRoot, mtimeEntries);
  return { inputs, uhtManifestPath, engineBuildId, ubtVersion, toolchainId };
}

export async function inputsStillValid(
  projectRoot: string,
  snapshotInputs: InputFingerprint[],
  options: CollectInputsOptions,
): Promise<boolean> {
  const current = await collectInputFingerprints({ ...options, projectRoot });
  const prevInventory = snapshotInputs.find((i) => i.path === '__project_input_inventory__');
  const nextInventory = current.inputs.find((i) => i.path === '__project_input_inventory__');
  if (!prevInventory || !nextInventory || prevInventory.sha256 !== nextInventory.sha256) return false;

  for (const input of snapshotInputs) {
    if (input.path.startsWith('__')) {
      const match = current.inputs.find((c) => c.path === input.path);
      if (!match || match.sha256 !== input.sha256) return false;
      continue;
    }
    const fp = await fingerprintFile(input.path);
    if (!fp || fp.sha256 !== input.sha256) return false;
  }
  return true;
}
