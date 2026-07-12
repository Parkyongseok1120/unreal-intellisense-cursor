import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildConfiguration, BuildPlatform, BuildTargetType, UEInstallation, UEProject } from '../types';
import type { CompileAction } from './projectModelService';
import { collectCompileActionsFromProject, compareActionHashes } from './projectModelService';
import { fileExists } from '../platform/paths';
import { collectInputFingerprints, inputsStillValid as validateInputs } from './snapshotInputs';
import { importAuthoritativeActionsFromRsp, collectRspPaths } from './rspActionImporter';
import { inferSnapshotKeyFromRsp, resolveSnapshotKey } from './snapshotKey';

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

export interface TuLinkageResult {
  linked: number;
  total: number;
  rate: number;
}

export interface BuildSnapshot {
  snapshotVersion: number;
  snapshotKey: string;
  projectRoot: string;
  projectId?: string;
  target?: string;
  platform?: string;
  configuration?: string;
  architecture?: string;
  engineId?: string;
  engineBuildId?: string;
  ubtVersion?: string;
  toolchainId?: string;
  uhtManifestPath?: string;
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
  flagParity: ParityResult;
  tuLinkage: TuLinkageResult;
  /** @deprecated v1 field */
  compileActions?: CompileAction[];
  version?: number;
}

export interface BuildSnapshotOptions {
  project: UEProject;
  engine?: UEInstallation;
  targetType?: BuildTargetType;
  platform?: BuildPlatform;
  configuration?: BuildConfiguration;
  architecture?: string;
}

export type SnapshotFreshnessOptions = Pick<
  BuildSnapshotOptions,
  'project' | 'targetType' | 'platform' | 'configuration' | 'architecture'
>;

export { collectRspPaths, importAuthoritativeActionsFromRsp } from './rspActionImporter';
export { normalizeParityArgs } from './rspActionImporter';

export async function buildCompileSnapshot(options: BuildSnapshotOptions): Promise<BuildSnapshot> {
  const { project, engine } = options;
  const projectRoot = project.projectRoot;
  const engineRoot = engine?.root ?? projectRoot;

  const key =
    resolveSnapshotKey({
      project,
      targetType: options.targetType,
      platform: options.platform,
      configuration: options.configuration,
      architecture: options.architecture,
    }) ?? inferSnapshotKeyFromRsp(projectRoot, project.name);

  if (!key) {
    throw new Error('Unable to resolve snapshot key — build Intermediate output first');
  }

  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
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

  const ideActions = await collectCompileActionsFromProject(projectRoot);
  const rspPaths = await collectRspPaths(projectRoot, key);
  const authoritativeActions = await importAuthoritativeActionsFromRsp(projectRoot, engineRoot, key);
  const inputMeta = await collectInputFingerprints({
    projectRoot,
    project,
    engine,
    engineRoot: engine?.root,
  });

  const authoritativeForParity =
    provenance === 'ubt-clang-db' && authoritativeActions.length > 0
      ? authoritativeActions
      : authoritativeActions.length > 0
        ? authoritativeActions
        : ideActions;

  const flagParity = compareActionHashes(authoritativeForParity, ideActions, { mode: 'flags' });
  const tuStats = compareActionHashes(authoritativeForParity, ideActions, { mode: 'tu' });
  const parity = flagParity;

  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        snapshotKey: key.snapshotKey,
        inputs: inputMeta.inputs,
        ideActions,
        authoritativeActions,
        synthetic,
        provenance,
      }),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    snapshotVersion: BUILD_SNAPSHOT_VERSION,
    snapshotKey: key.snapshotKey,
    projectRoot,
    projectId: key.projectId,
    engineId: project.engineAssociation,
    engineBuildId: inputMeta.engineBuildId,
    ubtVersion: inputMeta.ubtVersion,
    toolchainId: inputMeta.toolchainId,
    uhtManifestPath: inputMeta.uhtManifestPath,
    target: key.target,
    platform: key.platform,
    configuration: key.configuration,
    architecture: key.architecture,
    synthetic,
    syntheticReason,
    provenance,
    fingerprint,
    updatedAt: new Date().toISOString(),
    authoritativeActions,
    ideActions,
    rspPaths,
    inputs: inputMeta.inputs,
    parity,
    flagParity,
    tuLinkage: {
      linked: tuStats.tuLinked ?? 0,
      total: tuStats.tuTotal ?? 0,
      rate: tuStats.tuRate ?? 0,
    },
  };
}

export async function saveBuildSnapshot(projectRoot: string, snapshot: BuildSnapshot): Promise<string> {
  const dir = path.join(projectRoot, '.ue5_8cursor');
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, SNAPSHOT_FILE);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(snapshot, null, 2) + '\n';
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw error;
  }
  return filePath;
}

export async function inputsStillValid(snapshot: BuildSnapshot, engine?: UEInstallation): Promise<boolean> {
  return validateInputs(snapshot.projectRoot, snapshot.inputs, {
    projectRoot: snapshot.projectRoot,
    project: {
      name: snapshot.projectId ?? path.basename(snapshot.projectRoot),
      projectRoot: snapshot.projectRoot,
      uprojectPath: path.join(snapshot.projectRoot, `${snapshot.projectId ?? 'Project'}.uproject`),
      modules: [],
      engineAssociation: snapshot.engineId ?? '',
    },
    engine,
    engineRoot: engine?.root,
  });
}

export async function loadBuildSnapshot(projectRoot: string): Promise<BuildSnapshot | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, SNAPSHOT_FILE), 'utf-8');
      const snap = JSON.parse(raw) as BuildSnapshot;
      const version = snap.snapshotVersion ?? snap.version ?? 0;
      if (version < BUILD_SNAPSHOT_VERSION || !snap.snapshotKey) {
        return undefined;
      }
      if (!snap.ideActions && snap.compileActions) snap.ideActions = snap.compileActions;
      if (!snap.authoritativeActions) snap.authoritativeActions = snap.compileActions ?? [];
      if (!snap.parity) snap.parity = { matched: 0, total: 0, parity: 0 };
      if (!snap.flagParity) snap.flagParity = snap.parity;
      if (!snap.tuLinkage) snap.tuLinkage = { linked: 0, total: 0, rate: 0 };
      return snap;
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function snapshotFreshness(
  projectRoot: string,
  graphFingerprint?: string,
  engine?: UEInstallation,
  expected?: SnapshotFreshnessOptions,
): Promise<'ready' | 'partial' | 'stale' | 'missing'> {
  const snap = await loadBuildSnapshot(projectRoot);
  if (!snap) return 'missing';
  if (snap.synthetic) return 'partial';
  if (expected && snap.snapshotKey !== resolveSnapshotKey(expected).snapshotKey) return 'stale';
  if (!(await inputsStillValid(snap, engine))) return 'stale';
  if (graphFingerprint && graphFingerprint !== snap.fingerprint) return 'stale';
  const dbExists = await fileExists(path.join(projectRoot, 'compile_commands.json'));
  return dbExists ? 'ready' : 'missing';
}
