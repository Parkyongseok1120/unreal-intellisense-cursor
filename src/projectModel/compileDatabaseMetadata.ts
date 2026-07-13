import * as fs from 'fs';
import * as path from 'path';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import type { SnapshotKeyParts } from './snapshotKey';

export type CompileDatabaseSource = 'ubt' | 'rsp' | 'buildcs';

export interface CompileDatabaseMetadata {
  version: 1;
  source: CompileDatabaseSource;
  snapshotKey?: string;
  target?: string;
  platform?: string;
  configuration?: string;
  architecture?: string;
  entryCount: number;
  uniqueTuCount: number;
  /** RSP/Build.cs paths are intentionally partial until UBT proves actions. */
  authoritative: boolean;
  generatedAt: string;
}

export function compileDatabaseMetadataPath(projectRoot: string): string {
  return path.join(projectRoot, '.ue5_8cursor', 'compile-db.meta.json');
}

export async function writeCompileDatabaseMetadata(
  projectRoot: string,
  source: CompileDatabaseSource,
  entries: Array<{ file?: string }>,
  key?: SnapshotKeyParts,
  tx?: WorkspaceMutationTransaction,
): Promise<void> {
  const unique = new Set(entries.map((entry) => path.normalize(entry.file ?? '').toLowerCase()).filter(Boolean));
  const metadata: CompileDatabaseMetadata = {
    version: 1,
    source,
    snapshotKey: key?.snapshotKey,
    target: key?.target,
    platform: key?.platform,
    configuration: key?.configuration,
    architecture: key?.architecture,
    entryCount: entries.length,
    uniqueTuCount: unique.size,
    authoritative: source === 'ubt',
    generatedAt: new Date().toISOString(),
  };
  await mutateJson(tx, projectRoot, compileDatabaseMetadataPath(projectRoot), metadata);
}

export async function readCompileDatabaseMetadata(projectRoot: string): Promise<CompileDatabaseMetadata | undefined> {
  try {
    const raw = await fs.promises.readFile(compileDatabaseMetadataPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as CompileDatabaseMetadata;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
