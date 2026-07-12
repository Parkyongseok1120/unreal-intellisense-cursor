import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CompileAction } from '../projectModel/projectModelService';
import { collectCompileActionsFromProject } from '../projectModel/projectModelService';
import { fileExists } from '../platform/paths';

export const BUILD_SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = 'build-snapshot.json';

export type CompileDbProvenance = 'ubt' | 'rsp' | 'buildcs' | 'unknown';

export interface BuildSnapshot {
  version: number;
  projectRoot: string;
  target?: string;
  platform?: string;
  configuration?: string;
  engineId?: string;
  synthetic: boolean;
  syntheticReason?: string;
  provenance: CompileDbProvenance;
  fingerprint: string;
  updatedAt: string;
  compileActions: CompileAction[];
  rspPaths: string[];
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

export async function importActionsFromRsp(projectRoot: string): Promise<CompileAction[]> {
  const rspPaths = await collectRspPaths(projectRoot);
  const actions: CompileAction[] = [];

  for (const rspPath of rspPaths) {
    try {
      const raw = await fs.promises.readFile(rspPath, 'utf-8');
      const args = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const cpp = args.find((a) => a.endsWith('.cpp') || a.endsWith('.c'));
      if (!cpp) continue;
      const normalized = args.map((a) => a.replace(/\\/g, '/')).join('\0');
      actions.push({
        file: path.normalize(cpp),
        arguments: args,
        hash: hashString(normalized),
      });
    } catch {
      // skip unreadable rsp
    }
  }

  return actions;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function buildCompileSnapshot(project: {
  projectRoot: string;
  engineAssociation?: string;
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
      provenance = 'buildcs';
    } else if (raw.includes('UE5_8_CURSOR_RSP_DB=1')) {
      provenance = 'rsp';
    } else {
      provenance = 'ubt';
    }
  } catch {
    synthetic = true;
    syntheticReason = 'compile_commands.json missing';
  }

  let compileActions = await collectCompileActionsFromProject(project.projectRoot);
  const rspPaths = await collectRspPaths(project.projectRoot);
  const rspActions = await importActionsFromRsp(project.projectRoot);

  if (!synthetic && rspActions.length > 0) {
    compileActions = rspActions;
    provenance = 'rsp';
  }

  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ compileActions, rspPaths, synthetic, provenance }))
    .digest('hex')
    .slice(0, 16);

  return {
    version: BUILD_SNAPSHOT_VERSION,
    projectRoot: project.projectRoot,
    engineId: project.engineAssociation,
    synthetic,
    syntheticReason,
    provenance,
    fingerprint,
    updatedAt: new Date().toISOString(),
    compileActions,
    rspPaths,
  };
}

export async function saveBuildSnapshot(projectRoot: string, snapshot: BuildSnapshot): Promise<string> {
  const dir = path.join(projectRoot, '.ue5_8cursor');
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, SNAPSHOT_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function loadBuildSnapshot(projectRoot: string): Promise<BuildSnapshot | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, SNAPSHOT_FILE), 'utf-8');
      const snap = JSON.parse(raw) as BuildSnapshot;
      if (snap.version === BUILD_SNAPSHOT_VERSION) return snap;
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
