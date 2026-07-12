import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type MutationPolicy = 'auto' | 'consentRequired' | 'forbidden';

const POLICY_RANK: Record<MutationPolicy, number> = {
  auto: 0,
  consentRequired: 1,
  forbidden: 2,
};

export interface MutationRecord {
  absoluteTargetPath: string;
  relativeTargetPath: string;
  existedBefore: boolean;
  backupPath?: string;
  originalSha256?: string;
  createdDirs: string[];
}

export interface MutationWriteOpts {
  consentGranted?: boolean;
  /** Only allows making policy stricter (higher rank), never looser. */
  policyOverride?: MutationPolicy;
}

export interface MutationCommitResult {
  ok: boolean;
  changedFiles: string[];
  error?: string;
}

export interface MutationRollbackResult {
  ok: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  failedFiles: string[];
}

interface MutationJournal {
  sessionId: string;
  projectRoot: string;
  backupDir: string;
  records: MutationRecord[];
  startedAt: number;
}

const activeTransactions = new Map<string, WorkspaceMutationTransaction>();
const transactionLocks = new Map<string, Promise<void>>();

function sessionKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function journalPath(projectRoot: string): string {
  return path.join(projectRoot, '.ue5_8cursor', 'mutation-journal.json');
}

export function classifyPolicy(filePath: string): MutationPolicy {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.uproject') || base.endsWith('.uplugin')) return 'consentRequired';
  if (base.endsWith('.build.cs') || base.endsWith('.target.cs')) return 'forbidden';
  return 'auto';
}

function resolvePolicy(filePath: string, opts?: MutationWriteOpts): MutationPolicy {
  const base = classifyPolicy(filePath);
  const override = opts?.policyOverride;
  if (!override) return base;
  return POLICY_RANK[override] >= POLICY_RANK[base] ? override : base;
}

function relativeFromRoot(projectRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(projectRoot), path.resolve(absolutePath)).replace(/\\/g, '/');
}

function backupFileName(relativeTargetPath: string): string {
  const hash = crypto.createHash('sha256').update(relativeTargetPath).digest('hex').slice(0, 16);
  const safe = relativeTargetPath.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return `${hash}_${safe}.bak`;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function removeEmptyDirs(dirs: string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) {
    if (await isDirEmpty(dir)) {
      try {
        await fs.promises.rmdir(dir);
      } catch {
        // not empty or permission issue
      }
    }
  }
}

async function acquireLock(projectRoot: string): Promise<() => void> {
  const key = sessionKey(projectRoot);
  const prev = transactionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transactionLocks.set(
    key,
    prev.then(() => gate),
  );
  await prev;
  return () => {
    release();
  };
}

export class WorkspaceMutationTransaction {
  private readonly records: MutationRecord[] = [];
  private readonly backupDir: string;
  private readonly sessionId: string;
  private committed = false;
  private rolledBack = false;
  private readonly createdDirs = new Set<string>();

  private constructor(readonly projectRoot: string, backupDir: string, sessionId: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.backupDir = backupDir;
    this.sessionId = sessionId;
  }

  static async begin(projectRoot: string): Promise<WorkspaceMutationTransaction> {
    const key = sessionKey(projectRoot);
    if (activeTransactions.has(key)) {
      throw new Error(`Mutation transaction already active for ${projectRoot}`);
    }
    const release = await acquireLock(projectRoot);
    try {
      const backupDir = path.join(projectRoot, '.ue5_8cursor', 'backups', String(Date.now()));
      await fs.promises.mkdir(backupDir, { recursive: true });
      const sessionId = crypto.randomBytes(8).toString('hex');
      const tx = new WorkspaceMutationTransaction(projectRoot, backupDir, sessionId);
      activeTransactions.set(key, tx);
      await tx.persistJournal();
      return tx;
    } finally {
      release();
    }
  }

  private async persistJournal(): Promise<void> {
    const journal: MutationJournal = {
      sessionId: this.sessionId,
      projectRoot: this.projectRoot,
      backupDir: this.backupDir,
      records: this.records,
      startedAt: Date.now(),
    };
    await fs.promises.mkdir(path.dirname(journalPath(this.projectRoot)), { recursive: true });
    await fs.promises.writeFile(journalPath(this.projectRoot), JSON.stringify(journal, null, 2) + '\n', 'utf-8');
  }

  private async clearJournal(): Promise<void> {
    try {
      await fs.promises.unlink(journalPath(this.projectRoot));
    } catch {
      // no journal
    }
  }

  async writeText(absolutePath: string, content: string, opts?: MutationWriteOpts): Promise<void> {
    this.ensureOpen();
    const policy = resolvePolicy(absolutePath, opts);
    if (policy === 'forbidden') {
      throw new Error(`Mutation forbidden: ${absolutePath}`);
    }
    if (policy === 'consentRequired' && !opts?.consentGranted) {
      throw new Error(`Consent required: ${absolutePath}`);
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.json' || ext === '.uproject' || ext === '.uplugin') {
      try {
        JSON.parse(content);
      } catch (err) {
        throw new Error(`Invalid JSON for ${absolutePath}: ${err}`);
      }
    }

    const existedBefore = await fileExists(absolutePath);
    let previous = '';
    if (existedBefore) {
      previous = await fs.promises.readFile(absolutePath, 'utf-8');
      if (previous === content) return;
    }

    const relativeTargetPath = relativeFromRoot(this.projectRoot, absolutePath);
    const record: MutationRecord = {
      absoluteTargetPath: path.resolve(absolutePath),
      relativeTargetPath,
      existedBefore,
      createdDirs: [],
    };

    if (existedBefore) {
      const backupPath = path.join(this.backupDir, backupFileName(relativeTargetPath));
      await fs.promises.writeFile(backupPath, previous, 'utf-8');
      record.backupPath = backupPath;
      record.originalSha256 = sha256(previous);
    }

    const dir = path.dirname(absolutePath);
    if (!(await fileExists(dir))) {
      await fs.promises.mkdir(dir, { recursive: true });
      record.createdDirs.push(dir);
      this.createdDirs.add(dir);
    }

    const tempPath = `${absolutePath}.ue58cursor.tmp`;
    try {
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, absolutePath);
      this.records.push(record);
      await this.persistJournal();
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
      await this.rollbackRecordsFrom(this.records.length);
      throw err;
    }
  }

  async writeJson(absolutePath: string, value: unknown, opts?: MutationWriteOpts): Promise<void> {
    await this.writeText(absolutePath, JSON.stringify(value, null, 2) + '\n', opts);
  }

  private ensureOpen(): void {
    if (this.committed) throw new Error('Transaction already committed');
    if (this.rolledBack) throw new Error('Transaction already rolled back');
  }

  private async rollbackRecordsFrom(startIndex: number): Promise<void> {
    const slice = this.records.slice(startIndex).reverse();
    for (const record of slice) {
      if (record.existedBefore && record.backupPath) {
        const content = await fs.promises.readFile(record.backupPath, 'utf-8');
        await fs.promises.writeFile(record.absoluteTargetPath, content, 'utf-8');
      } else if (!record.existedBefore && (await fileExists(record.absoluteTargetPath))) {
        await fs.promises.unlink(record.absoluteTargetPath);
      }
      await removeEmptyDirs(record.createdDirs);
    }
    this.records.splice(startIndex);
  }

  async commit(): Promise<MutationCommitResult> {
    this.ensureOpen();
    this.committed = true;
    activeTransactions.delete(sessionKey(this.projectRoot));
    await this.clearJournal();
    return {
      ok: true,
      changedFiles: this.records.map((r) => r.relativeTargetPath),
    };
  }

  async rollback(): Promise<MutationRollbackResult> {
    if (this.committed) {
      return { ok: false, restoredFiles: [], deletedFiles: [], failedFiles: ['transaction already committed'] };
    }
    this.rolledBack = true;
    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (const record of [...this.records].reverse()) {
      try {
        if (record.existedBefore && record.backupPath) {
          const content = await fs.promises.readFile(record.backupPath, 'utf-8');
          await fs.promises.writeFile(record.absoluteTargetPath, content, 'utf-8');
          restoredFiles.push(record.relativeTargetPath);
        } else if (!record.existedBefore && (await fileExists(record.absoluteTargetPath))) {
          await fs.promises.unlink(record.absoluteTargetPath);
          deletedFiles.push(record.relativeTargetPath);
        }
        await removeEmptyDirs(record.createdDirs);
      } catch {
        failedFiles.push(record.relativeTargetPath);
      }
    }

    this.records.length = 0;
    activeTransactions.delete(sessionKey(this.projectRoot));
    await this.clearJournal();
    return { ok: failedFiles.length === 0, restoredFiles, deletedFiles, failedFiles };
  }
}

export async function runWithTransaction<T>(
  projectRoot: string,
  fn: (tx: WorkspaceMutationTransaction) => Promise<T>,
): Promise<T> {
  const tx = await WorkspaceMutationTransaction.begin(projectRoot);
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export function getActiveTransaction(projectRoot: string): WorkspaceMutationTransaction | undefined {
  return activeTransactions.get(sessionKey(projectRoot));
}

export async function mutateText(
  tx: WorkspaceMutationTransaction | undefined,
  projectRoot: string,
  filePath: string,
  content: string,
  opts?: MutationWriteOpts,
): Promise<void> {
  if (tx) {
    await tx.writeText(filePath, content, opts);
    return;
  }
  const result = await writeProjectFileAtomic({
    projectRoot,
    filePath,
    content,
    consentGranted: opts?.consentGranted,
    policy: opts?.policyOverride,
  });
  if (result.error) throw new Error(result.error);
}

export async function mutateJson(
  tx: WorkspaceMutationTransaction | undefined,
  projectRoot: string,
  filePath: string,
  value: unknown,
  opts?: MutationWriteOpts,
): Promise<void> {
  await mutateText(tx, projectRoot, filePath, JSON.stringify(value, null, 2) + '\n', opts);
}

/** @deprecated Prefer WorkspaceMutationTransaction within runWithTransaction */
export async function writeProjectFileAtomic(options: {
  projectRoot: string;
  filePath: string;
  content: string;
  consentGranted?: boolean;
  policy?: MutationPolicy;
}): Promise<{ changed: boolean; rolledBack: boolean; error?: string }> {
  const key = sessionKey(options.projectRoot);
  const existing = activeTransactions.get(key);
  try {
    if (existing) {
      await existing.writeText(options.filePath, options.content, {
        consentGranted: options.consentGranted,
        policyOverride: options.policy,
      });
      return { changed: true, rolledBack: false };
    }
    await runWithTransaction(options.projectRoot, async (tx) => {
      await tx.writeText(options.filePath, options.content, {
        consentGranted: options.consentGranted,
        policyOverride: options.policy,
      });
    });
    return { changed: true, rolledBack: false };
  } catch (err) {
    return { changed: false, rolledBack: true, error: String(err) };
  }
}

export async function rollbackSession(projectRoot: string): Promise<boolean> {
  const tx = activeTransactions.get(sessionKey(projectRoot));
  if (!tx) return false;
  const result = await tx.rollback();
  return result.ok;
}

export function clearMutationSession(projectRoot: string): void {
  activeTransactions.delete(sessionKey(projectRoot));
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

export function canOverridePolicy(filePath: string, requested: MutationPolicy): boolean {
  const base = classifyPolicy(filePath);
  return POLICY_RANK[requested] >= POLICY_RANK[base];
}
