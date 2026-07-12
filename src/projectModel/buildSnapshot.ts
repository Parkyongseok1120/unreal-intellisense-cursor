import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CompileAction } from '../projectModel/projectModelService';
import { collectCompileActionsFromProject, compareActionHashes } from '../projectModel/projectModelService';
import { fileExists } from '../platform/paths';

export const BUILD_SNAPSHOT_VERSION = 3;
const SNAPSHOT_FILE = 'build-snapshot.json';

export type CompileDbProvenance = 'ubt-clang-db' | 'ubt-rsp' | 'synthetic-buildcs' | 'unknown';

export interface InputFingerprint {
  path: string;
  sha256: string;
}

export interface ParityResult {
  matched: number;
  total: number;
  parity: number;
}

export interface BuildSnapshot {
  snapshotVersion: number;
  projectRoot: string;
  projectId?: string;
  target?: string;
  platform?: string;
  configuration?: string;
  architecture?: string;
  engineId?: string;
  synthetic: boolean;
  syntheticReason?: string;
  provenance: CompileDbProvenance;
  fingerprint: string;
  updatedAt: string;
  authoritativeActions: CompileAction[];
  ideActions: CompileAction[];
  rspPaths: string[];
  inputs: InputFingerprint[];
  parity: ParityResult;
  /** @deprecated v1 field */
  compileActions?: CompileAction[];
  version?: number;
}

export async function collectRspPaths(projectRoot: string): Promise<string[]> {
  const buildDir = path.join(projectRoot, 'Intermediate', 'Build');
  const rspFiles: string[] = [];
  await walkRsp(buildDir, rspFiles, 0);
  return rspFiles;
}

async function walkRsp(dir: string, out: string[], depth: number): Promise<void> {
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
      await walkRsp(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.rsp')) {
      out.push(full);
    }
  }
}

function parseRspLine(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur.length > 0) {
        args.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) args.push(cur);
  return args;
}

export async function importActionsFromRsp(projectRoot: string): Promise<CompileAction[]> {
  const rspPaths = await collectRspPaths(projectRoot);
  const actions: CompileAction[] = [];
  const seen = new Set<string>();

  for (const rspPath of rspPaths) {
    try {
      const raw = await fs.promises.readFile(rspPath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const args: string[] = [];
      for (const line of lines) {
        if (line.startsWith('@')) {
          const nested = line.slice(1).trim();
          try {
            const nestedRaw = await fs.promises.readFile(path.isAbsolute(nested) ? nested : path.join(path.dirname(rspPath), nested), 'utf-8');
            for (const nl of nestedRaw.split(/\r?\n/)) {
              args.push(...parseRspLine(nl));
            }
          } catch {
            args.push(...parseRspLine(line));
          }
        } else {
          args.push(...parseRspLine(line));
        }
      }
      const cpp = args.find((a) => /\.(cpp|c|cc|cxx)$/i.test(a) && !a.startsWith('/Fo') && !a.startsWith('-Fo'));
      if (!cpp) continue;
      const normFile = path.normalize(cpp);
      if (seen.has(normFile)) continue;
      seen.add(normFile);
      const normalized = normalizeParityArgs(args);
      actions.push({
        file: normFile,
        arguments: args,
        hash: hashString(normalized),
      });
    } catch {
      // skip
    }
  }

  return actions;
}

export function normalizeParityArgs(args: string[]): string {
  return args
    .map((a) => a.replace(/\\/g, '/'))
    .filter((a) => {
      if (!a.length) return false;
      if (a.startsWith('/Fo') || a.startsWith('-Fo')) return false;
      if (a.endsWith('.obj') || a.endsWith('.o')) return false;
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

async function collectInputFingerprints(projectRoot: string): Promise<InputFingerprint[]> {
  const inputs: InputFingerprint[] = [];
  const uproject = (await fs.promises.readdir(projectRoot)).find((f) => f.endsWith('.uproject'));
  if (uproject) {
    const fp = await fingerprintFile(path.join(projectRoot, uproject));
    if (fp) inputs.push(fp);
  }
  const compileDb = await fingerprintFile(path.join(projectRoot, 'compile_commands.json'));
  if (compileDb) inputs.push(compileDb);

  const buildConfig = await fingerprintFile(path.join(projectRoot, 'Config', 'BuildConfiguration.xml'));
  if (buildConfig) inputs.push(buildConfig);

  await walkFingerprint(projectRoot, /\.(Build|Target)\.cs$/i, inputs, 0);
  await walkFingerprint(projectRoot, /\.uplugin$/i, inputs, 0);

  const rspPaths = await collectRspPaths(projectRoot);
  const rspHashes: string[] = [];
  for (const rsp of rspPaths.sort()) {
    const fp = await fingerprintFile(rsp);
    if (fp) rspHashes.push(fp.sha256);
  }
  if (rspHashes.length > 0) {
    inputs.push({
      path: '__rsp_merkle__',
      sha256: crypto.createHash('sha256').update(rspHashes.join('\n')).digest('hex'),
    });
  }
  const inventory = inputs
    .filter((input) => !input.path.startsWith('__'))
    .map((input) => `${path.relative(projectRoot, input.path).replace(/\\/g, '/')}\0${input.sha256}`)
    .sort()
    .join('\n');
  inputs.push({
    path: '__project_input_inventory__',
    sha256: crypto.createHash('sha256').update(inventory).digest('hex'),
  });
  return inputs;
}

const FINGERPRINT_SKIP_DIRS = new Set([
  '.git',
  '.ue5_8cursor',
  '.ue58rider',
  'Binaries',
  'DerivedDataCache',
  'Intermediate',
  'Saved',
  'node_modules',
]);

async function walkFingerprint(dir: string, pattern: RegExp, out: InputFingerprint[], depth: number): Promise<void> {
  if (depth > 10) return;
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

export async function buildCompileSnapshot(project: {
  projectRoot: string;
  engineAssociation?: string;
  target?: string;
  platform?: string;
  configuration?: string;
}): Promise<BuildSnapshot> {
  const compileDbPath = path.join(project.projectRoot, 'compile_commands.json');
  let synthetic = false;
  let syntheticReason: string | undefined;
  let provenance: CompileDbProvenance = 'unknown';

  try {
    const raw = await fs.promises.readFile(compileDbPath, 'utf-8');
    if (raw.includes('UE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1')) {
      synthetic = true;
      syntheticReason = 'synthetic compile_commands marker';
      provenance = 'synthetic-buildcs';
    } else if (raw.includes('UE5_8_CURSOR_RSP_DB=1')) {
      provenance = 'ubt-rsp';
    } else {
      provenance = 'ubt-clang-db';
    }
  } catch {
    synthetic = true;
    syntheticReason = 'compile_commands.json missing';
  }

  const ideActions = await collectCompileActionsFromProject(project.projectRoot);
  const rspPaths = await collectRspPaths(project.projectRoot);
  const authoritativeActions = await importActionsFromRsp(project.projectRoot);
  const inputs = await collectInputFingerprints(project.projectRoot);

  const parity = compareActionHashes(
    provenance === 'ubt-clang-db' ? authoritativeActions : ideActions,
    ideActions,
  );

  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ inputs, ideActions, authoritativeActions, synthetic, provenance }))
    .digest('hex')
    .slice(0, 16);

  return {
    snapshotVersion: BUILD_SNAPSHOT_VERSION,
    projectRoot: project.projectRoot,
    projectId: path.basename(project.projectRoot),
    engineId: project.engineAssociation,
    target: project.target,
    platform: project.platform,
    configuration: project.configuration,
    architecture: process.arch,
    synthetic,
    syntheticReason,
    provenance,
    fingerprint,
    updatedAt: new Date().toISOString(),
    authoritativeActions,
    ideActions,
    rspPaths,
    inputs,
    parity,
  };
}

export async function saveBuildSnapshot(projectRoot: string, snapshot: BuildSnapshot): Promise<string> {
  const dir = path.join(projectRoot, '.ue5_8cursor');
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, SNAPSHOT_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function inputsStillValid(snapshot: BuildSnapshot): Promise<boolean> {
  for (const input of snapshot.inputs) {
    if (input.path === '__project_input_inventory__') {
      const current = await collectInputFingerprints(snapshot.projectRoot);
      const inventory = current.find((candidate) => candidate.path === '__project_input_inventory__');
      if (!inventory || inventory.sha256 !== input.sha256) return false;
      continue;
    }
    if (input.path === '__rsp_merkle__') {
      const rspPaths = await collectRspPaths(snapshot.projectRoot);
      const rspHashes: string[] = [];
      for (const rsp of rspPaths.sort()) {
        const fp = await fingerprintFile(rsp);
        if (fp) rspHashes.push(fp.sha256);
      }
      const merkle = crypto.createHash('sha256').update(rspHashes.join('\n')).digest('hex');
      if (merkle !== input.sha256) return false;
      continue;
    }
    const fp = await fingerprintFile(input.path);
    if (!fp || fp.sha256 !== input.sha256) return false;
  }
  return true;
}

export async function loadBuildSnapshot(projectRoot: string): Promise<BuildSnapshot | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, SNAPSHOT_FILE), 'utf-8');
      const snap = JSON.parse(raw) as BuildSnapshot;
      const version = snap.snapshotVersion ?? snap.version ?? 0;
      if (version >= 2 && version <= BUILD_SNAPSHOT_VERSION) {
        if (!snap.ideActions && snap.compileActions) snap.ideActions = snap.compileActions;
        if (!snap.authoritativeActions) snap.authoritativeActions = snap.compileActions ?? [];
        if (!snap.parity) snap.parity = { matched: 0, total: 0, parity: 0 };
        if (version < BUILD_SNAPSHOT_VERSION) snap.snapshotVersion = BUILD_SNAPSHOT_VERSION;
        if (snap.inputs?.length && !(await inputsStillValid(snap))) {
          snap.synthetic = true;
          snap.syntheticReason = 'input fingerprints stale on load';
        }
        return snap;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function snapshotFreshness(
  projectRoot: string,
  graphFingerprint?: string,
): Promise<'ready' | 'partial' | 'stale' | 'missing'> {
  const snap = await loadBuildSnapshot(projectRoot);
  if (!snap) return 'missing';
  if (snap.synthetic) return 'partial';
  if (graphFingerprint && graphFingerprint !== snap.fingerprint) return 'stale';
  const dbExists = await fileExists(path.join(projectRoot, 'compile_commands.json'));
  return dbExists ? 'ready' : 'missing';
}
