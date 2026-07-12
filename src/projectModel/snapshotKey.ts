import * as fs from 'fs';
import * as path from 'path';
import { resolveTargetName } from '../build/ubt';
import type { BuildConfiguration, BuildPlatform, BuildTargetType, UEInstallation, UEProject } from '../types';

export interface SnapshotKeyParts {
  projectId: string;
  target: string;
  platform: string;
  configuration: string;
  architecture: string;
  snapshotKey: string;
  intermediateSegment: string;
}

export interface SnapshotKeyOptions {
  project: UEProject;
  targetType?: BuildTargetType;
  platform?: BuildPlatform;
  configuration?: BuildConfiguration;
  architecture?: string;
}

const DEFAULT_ARCH = 'x64';

export function resolveSnapshotKey(options: SnapshotKeyOptions): SnapshotKeyParts {
  const targetType = options.targetType ?? 'Editor';
  const platform = options.platform ?? 'Win64';
  const configuration = options.configuration ?? 'Development';
  const target = resolveTargetName(options.project, targetType);
  const projectId = options.project.name;
  const architecture = options.architecture ?? DEFAULT_ARCH;
  const snapshotKey = `${projectId}/${platform}/${configuration}/${target}/${architecture}`;
  const intermediateSegment = path.join('Intermediate', 'Build', platform, architecture, target, configuration);
  return { projectId, target, platform, configuration, architecture, snapshotKey, intermediateSegment };
}

/** Infer key segments from the first matching Intermediate/Build path when settings are absent. */
export function inferSnapshotKeyFromRsp(projectRoot: string, projectName: string): SnapshotKeyParts | undefined {
  const base = path.join(projectRoot, 'Intermediate', 'Build');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const platformEntry of entries) {
    if (!platformEntry.isDirectory()) continue;
    const platform = platformEntry.name;
    const platformDir = path.join(base, platform);
    let archEntries: fs.Dirent[];
    try {
      archEntries = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const archEntry of archEntries) {
      if (!archEntry.isDirectory()) continue;
      const architecture = archEntry.name;
      const archDir = path.join(platformDir, architecture);
      let targetEntries: fs.Dirent[];
      try {
        targetEntries = fs.readdirSync(archDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const targetEntry of targetEntries) {
        if (!targetEntry.isDirectory()) continue;
        const target = targetEntry.name;
        const targetDir = path.join(archDir, target);
        let configEntries: fs.Dirent[];
        try {
          configEntries = fs.readdirSync(targetDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const configEntry of configEntries) {
          if (!configEntry.isDirectory()) continue;
          const configuration = configEntry.name;
          const hasRsp = fs
            .readdirSync(path.join(targetDir, configuration))
            .some((f) => f.endsWith('.Shared.rsp') || f.endsWith('.cpp.obj.rsp'));
          if (!hasRsp) continue;
          const snapshotKey = `${projectName}/${platform}/${configuration}/${target}/${architecture}`;
          return {
            projectId: projectName,
            target,
            platform,
            configuration,
            architecture,
            snapshotKey,
            intermediateSegment: path.join('Intermediate', 'Build', platform, architecture, target, configuration),
          };
        }
      }
    }
  }
  return undefined;
}

export function rspPathMatchesKey(rspPath: string, projectRoot: string, key: SnapshotKeyParts): boolean {
  const norm = rspPath.replace(/\\/g, '/').toLowerCase();
  const segment = path.join(projectRoot, key.intermediateSegment).replace(/\\/g, '/').toLowerCase();
  return norm.startsWith(segment);
}

export async function readEngineBuildId(engineRoot?: string): Promise<string | undefined> {
  if (!engineRoot) return undefined;
  const candidates = [
    path.join(engineRoot, 'Engine', 'Build', 'Build.version'),
    path.join(engineRoot, 'Engine', 'Build', 'BuildVersion.txt'),
  ];
  for (const candidate of candidates) {
    try {
      return (await fs.promises.readFile(candidate, 'utf-8')).trim().slice(0, 256);
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function readUbtToolchainId(engine?: UEInstallation): Promise<string | undefined> {
  if (!engine?.ubtPath) return undefined;
  const candidates = [
    engine.ubtPath,
    path.join(engine.root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll'),
  ];
  const identities: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      identities.push(`${candidate}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      // optional layout-specific UBT binary
    }
  }
  return identities.length ? `ubt:${identities.join('|')}` : undefined;
}

/** Compiler/toolchain fingerprint, independent from the UBT executable itself. */
export async function readToolchainId(engine?: UEInstallation): Promise<string | undefined> {
  const candidates = [
    process.env.VCToolsInstallDir && path.join(process.env.VCToolsInstallDir, 'bin', 'Hostx64', 'x64', 'cl.exe'),
    process.env.WindowsSdkDir && path.join(process.env.WindowsSdkDir, 'bin', 'x64', 'rc.exe'),
    engine && path.join(engine.root, 'Engine', 'Extras', 'ThirdPartyNotUE', 'SDKs', 'HostWin64', 'Win64'),
  ].filter((candidate): candidate is string => !!candidate);
  const identities: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      identities.push(`${candidate}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      // machine-specific toolchain is optional
    }
  }
  return identities.length ? `toolchain:${identities.join('|')}` : undefined;
}
