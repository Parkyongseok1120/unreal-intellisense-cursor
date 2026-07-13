import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_DATA_DIR } from '../constants';
import { mutateJson } from '../platform/workspaceMutation';

export interface UbtBuildEvidence {
  version: 1;
  completedAt: string;
  title: string;
  success: boolean;
  exitCode: number;
}

function evidencePath(projectRoot: string): string {
  return path.join(projectRoot, EXTENSION_DATA_DIR, 'metrics', 'last-ubt-build.json');
}

/**
 * This is intentionally a build outcome rather than a claim that clangd and
 * UBT agree. A diagnostic baseline can therefore make the distinction visible.
 */
export async function recordUbtBuildEvidence(
  projectRoot: string,
  input: Omit<UbtBuildEvidence, 'version' | 'completedAt'> & { completedAt?: string },
): Promise<UbtBuildEvidence> {
  const evidence: UbtBuildEvidence = {
    version: 1,
    completedAt: input.completedAt ?? new Date().toISOString(),
    title: input.title,
    success: input.success,
    exitCode: input.exitCode,
  };
  await mutateJson(undefined, projectRoot, evidencePath(projectRoot), evidence);
  return evidence;
}

export async function readUbtBuildEvidence(projectRoot: string): Promise<UbtBuildEvidence | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(evidencePath(projectRoot), 'utf-8')) as Partial<UbtBuildEvidence>;
    if (parsed.version !== 1 || typeof parsed.completedAt !== 'string' || typeof parsed.success !== 'boolean' || typeof parsed.exitCode !== 'number') {
      return undefined;
    }
    return {
      version: 1,
      completedAt: parsed.completedAt,
      title: typeof parsed.title === 'string' ? parsed.title : 'Build',
      success: parsed.success,
      exitCode: parsed.exitCode,
    };
  } catch {
    return undefined;
  }
}

