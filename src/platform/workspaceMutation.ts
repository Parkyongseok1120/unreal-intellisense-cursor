import * as fs from 'fs';
import * as path from 'path';

export type MutationPolicy = 'auto' | 'consentRequired' | 'forbidden';

export interface MutationTarget {
  filePath: string;
  policy: MutationPolicy;
}

export interface MutationWriteOptions {
  projectRoot: string;
  filePath: string;
  content: string;
  policy?: MutationPolicy;
  consentGranted?: boolean;
}

export interface MutationResult {
  changed: boolean;
  rolledBack: boolean;
  backupPath?: string;
  error?: string;
}

const backupSessions = new Map<string, string[]>();

function sessionKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function classifyPolicy(filePath: string, override?: MutationPolicy): MutationPolicy {
  if (override) return override;
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.uproject') || base.endsWith('.uplugin')) return 'consentRequired';
  if (base.endsWith('.build.cs') || base.endsWith('.target.cs')) return 'forbidden';
  return 'auto';
}

async function ensureBackupDir(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.ue5_8cursor', 'backups', String(Date.now()));
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function snapshotFile(filePath: string, backupDir: string): Promise<string | undefined> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const backupPath = path.join(backupDir, path.basename(filePath) + '.bak');
    await fs.promises.writeFile(backupPath, content, 'utf-8');
    return backupPath;
  } catch {
    return undefined;
  }
}

function validateJson(content: string): string | undefined {
  try {
    JSON.parse(content);
    return undefined;
  } catch (err) {
    return `Invalid JSON: ${err}`;
  }
}

export async function writeProjectFileAtomic(options: MutationWriteOptions): Promise<MutationResult> {
  const policy = classifyPolicy(options.filePath, options.policy);
  if (policy === 'forbidden') {
    return { changed: false, rolledBack: false, error: `Mutation forbidden: ${options.filePath}` };
  }
  if (policy === 'consentRequired' && !options.consentGranted) {
    return { changed: false, rolledBack: false, error: `Consent required: ${options.filePath}` };
  }

  const ext = path.extname(options.filePath).toLowerCase();
  if (ext === '.json') {
    const jsonError = validateJson(options.content);
    if (jsonError) return { changed: false, rolledBack: false, error: jsonError };
  }

  const key = sessionKey(options.projectRoot);
  let backups = backupSessions.get(key);
  if (!backups) {
    const backupDir = await ensureBackupDir(options.projectRoot);
    backups = [];
    backupSessions.set(key, backups);
    const existingBackup = await snapshotFile(options.filePath, backupDir);
    if (existingBackup) backups.push(existingBackup);
  } else if (await fileExists(options.filePath)) {
    const backupDir = path.dirname(backups[0] ?? path.join(options.projectRoot, '.ue5_8cursor', 'backups'));
    const existingBackup = await snapshotFile(options.filePath, backupDir);
    if (existingBackup) backups.push(existingBackup);
  }

  const dir = path.dirname(options.filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tempPath = `${options.filePath}.ue58cursor.tmp`;
  try {
    let previous = '';
    try {
      previous = await fs.promises.readFile(options.filePath, 'utf-8');
    } catch {
      // new file
    }

    if (previous === options.content) {
      return { changed: false, rolledBack: false, backupPath: backups?.[backups.length - 1] };
    }

    await fs.promises.writeFile(tempPath, options.content, 'utf-8');
    await fs.promises.rename(tempPath, options.filePath);
    return { changed: true, rolledBack: false, backupPath: backups?.[backups.length - 1] };
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore
    }
    return { changed: false, rolledBack: false, error: String(err) };
  }
}

export async function rollbackSession(projectRoot: string): Promise<boolean> {
  const key = sessionKey(projectRoot);
  const backups = backupSessions.get(key);
  if (!backups?.length) return false;

  let restored = false;
  for (const backupPath of [...backups].reverse()) {
    const originalName = path.basename(backupPath).replace(/\.bak$/, '');
    const originalPath = path.join(path.dirname(path.dirname(path.dirname(backupPath))), originalName);
    // backup lives under .ue5_8cursor/backups/<ts>/<name>.bak — resolve from project root instead
    const projectRootResolved = path.resolve(projectRoot);
    const candidateRoots = [
      projectRootResolved,
      path.join(projectRootResolved, '.vscode'),
      path.join(projectRootResolved, '.cursor'),
    ];
    for (const root of candidateRoots) {
      const target = path.join(root, originalName);
      if (await fileExists(target) || originalName === 'settings.json' || originalName === 'mcp.json') {
        try {
          const content = await fs.promises.readFile(backupPath, 'utf-8');
          await fs.promises.writeFile(target, content, 'utf-8');
          restored = true;
        } catch {
          // try next
        }
      }
    }
  }

  backupSessions.delete(key);
  return restored;
}

export function clearMutationSession(projectRoot: string): void {
  backupSessions.delete(sessionKey(projectRoot));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Remove only extension-managed explorer filter patterns, preserving user entries. */
export function removeManagedExplorerPatterns(
  existing: Record<string, boolean> | undefined,
  managed: Record<string, boolean>,
): Record<string, boolean> | undefined {
  if (!existing) return undefined;
  const result = { ...existing };
  for (const key of Object.keys(managed)) {
    if (managed[key] === true) {
      delete result[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
