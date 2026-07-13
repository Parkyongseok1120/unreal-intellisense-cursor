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
  postWriteSha256?: string;
  status: 'pending' | 'committed';
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
  conflictFiles?: string[];
}

export interface MutationRecoveryResult {
  recovered: boolean;
  rolledBack: boolean;
  conflict: boolean;
  message?: string;
}

interface MutationJournal {
  sessionId: string;
  projectRoot: string;
  backupDir: string;
  records: MutationRecord[];
  startedAt: number;
  state?: 'active' | 'committing' | 'committed' | 'rollingBack' | 'rollback-conflict';
}

const activeTransactions = new Map<string, WorkspaceMutationTransaction>();
const transactionLocks = new Map<string, Promise<void>>();

function sessionKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function journalPath(projectRoot: string): string {
  return path.join(projectRoot, '.ue5_8cursor', 'mutation-journal.json');
}

/** Reject writes outside the project root (extension-managed paths only). */
export function assertPathContained(projectRoot: string, absolutePath: string): void {
  const root = path.resolve(projectRoot);
  const target = path.resolve(absolutePath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Mutation path outside project root: ${target}`);
  }
}

const ALLOWED_ROOT_FILES = new Set([
  'compile_commands.json',
  '.clangd',
  '.vsconfig',
]);

/** Paths the extension may mutate under a project root. */
export function isExtensionManagedMutationPath(projectRoot: string, absolutePath: string): boolean {
  assertPathContained(projectRoot, absolutePath);
  const rel = relativeFromRoot(projectRoot, absolutePath).replace(/\\/g, '/');
  if (ALLOWED_ROOT_FILES.has(rel)) return true;
  if (rel.startsWith('.ue5_8cursor/')) return true;
  if (rel.startsWith('.vscode/')) return true;
  if (rel.startsWith('.cursor/')) return true;
  if (rel.startsWith('Plugins/UE58CursorBridge/')) return true;
  const base = path.basename(absolutePath).toLowerCase();
  if (base.endsWith('.uproject') || base.endsWith('.uplugin') || base.endsWith('.build.cs')) return true;
  if (base.endsWith('.target.cs')) return false;
  if (rel.includes('/Source/') || rel.includes('/Plugins/')) return true;
  if (rel.includes('/Config/')) return true;
  return false;
}

export function classifyPolicy(filePath: string): MutationPolicy {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.uproject') || base.endsWith('.uplugin')) return 'consentRequired';
  if (base.endsWith('.build.cs')) return 'consentRequired';
  if (base.endsWith('.target.cs')) return 'forbidden';
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

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(p: string): Promise<string | undefined> {
  if (!(await fileExists(p))) return undefined;
  return fs.promises.readFile(p, 'utf-8');
}

async function fileSha256(absolutePath: string): Promise<string | undefined> {
  try {
    const buf = await fs.promises.readFile(absolutePath);
    return sha256Buffer(buf);
  } catch {
    return undefined;
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

async function atomicReplace(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch (err) {
    if (process.platform === 'win32') {
      await fs.promises.copyFile(source, target);
      await fs.promises.unlink(source);
      return;
    }
    throw err;
  }
}

async function acquireLock(projectRoot: string): Promise<() => void> {
  const key = sessionKey(projectRoot);
  const prev = transactionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => gate);
  transactionLocks.set(key, chain);
  await prev;
  return () => {
    release();
    void chain.finally(() => {
      if (transactionLocks.get(key) === chain) {
        transactionLocks.delete(key);
      }
    });
  };
}

async function loadJournal(projectRoot: string): Promise<MutationJournal | undefined> {
  try {
    const raw = await fs.promises.readFile(journalPath(projectRoot), 'utf-8');
    return JSON.parse(raw) as MutationJournal;
  } catch {
    return undefined;
  }
}

async function saveJournal(projectRoot: string, journal: MutationJournal): Promise<void> {
  const finalPath = journalPath(projectRoot);
  const tempPath = `${finalPath}.${journal.sessionId || 'recovery'}.tmp`;
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.promises.writeFile(tempPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8');
  await atomicReplace(tempPath, finalPath);
}

async function rollbackJournalRecords(
  projectRoot: string,
  journal: MutationJournal,
): Promise<MutationRollbackResult> {
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];
  const conflictFiles: string[] = [];

  for (const record of [...journal.records].reverse()) {
    try {
      if (record.existedBefore && record.backupPath && (await fileExists(record.backupPath))) {
        const currentHash = await fileSha256(record.absoluteTargetPath);
        if (record.postWriteSha256 && currentHash !== undefined && currentHash !== record.postWriteSha256) {
          conflictFiles.push(record.relativeTargetPath);
          continue;
        }
        const content = await fs.promises.readFile(record.backupPath);
        await fs.promises.writeFile(record.absoluteTargetPath, content);
        restoredFiles.push(record.relativeTargetPath);
      } else if (!record.existedBefore && (await fileExists(record.absoluteTargetPath))) {
        const currentHash = await fileSha256(record.absoluteTargetPath);
        if (currentHash !== undefined && record.postWriteSha256 && currentHash !== record.postWriteSha256) {
          conflictFiles.push(record.relativeTargetPath);
          continue;
        }
        await fs.promises.unlink(record.absoluteTargetPath);
        deletedFiles.push(record.relativeTargetPath);
      }
      await removeEmptyDirs(record.createdDirs);
    } catch {
      failedFiles.push(record.relativeTargetPath);
    }
  }

  const ok = failedFiles.length === 0 && conflictFiles.length === 0;
  if (!ok) {
    journal.state = 'rollback-conflict';
    await saveJournal(projectRoot, journal);
    return {
      ok: false,
      restoredFiles,
      deletedFiles,
      failedFiles,
      conflictFiles,
    };
  }

  try {
    await fs.promises.unlink(journalPath(projectRoot));
  } catch {
    // ignore
  }

  return {
    ok: true,
    restoredFiles,
    deletedFiles,
    failedFiles,
    conflictFiles,
  };
}

/** Recover an orphaned journal left by a crashed extension host. */
export async function recoverIncompleteMutations(projectRoot: string): Promise<MutationRecoveryResult> {
  const key = sessionKey(projectRoot);
  if (activeTransactions.has(key)) {
    return { recovered: false, rolledBack: false, conflict: false, message: 'Active transaction in progress' };
  }
  const journal = await loadJournal(projectRoot);
  if (!journal) {
    return { recovered: true, rolledBack: false, conflict: false };
  }
  if (journal.state === 'committed' || journal.state === 'committing') {
    try {
      await fs.promises.unlink(journalPath(projectRoot));
    } catch {
      // best-effort cleanup
    }
    return {
      recovered: true,
      rolledBack: false,
      conflict: false,
      message: journal.state === 'committed'
        ? 'Cleared committed mutation journal'
        : 'Cleared in-progress commit journal without rollback',
    };
  }
  if (journal.state === 'rollback-conflict') {
    return {
      recovered: false,
      rolledBack: false,
      conflict: true,
      message: 'Mutation journal requires manual resolution (rollback conflict)',
    };
  }
  if (journal.records.length === 0) {
    try {
      await fs.promises.unlink(journalPath(projectRoot));
    } catch {
      // best-effort cleanup
    }
    return { recovered: true, rolledBack: false, conflict: false };
  }
  const result = await rollbackJournalRecords(projectRoot, journal);
  if (result.conflictFiles?.length || result.failedFiles?.length) {
    return {
      recovered: false,
      rolledBack: false,
      conflict: true,
      message: `Mutation recovery conflict on: ${[...(result.conflictFiles ?? []), ...(result.failedFiles ?? [])].join(', ')}`,
    };
  }
  try {
    await fs.promises.unlink(journalPath(projectRoot));
  } catch {
    // journal already removed
  }
  return {
    recovered: true,
    rolledBack: true,
    conflict: false,
    message: result.restoredFiles.length || result.deletedFiles.length
      ? 'Recovered incomplete mutation journal'
      : undefined,
  };
}

export class WorkspaceMutationTransaction {
  private readonly records: MutationRecord[] = [];
  private readonly backupDir: string;
  private readonly sessionId: string;
  private committed = false;
  private rolledBack = false;
  private journalState: MutationJournal['state'] = 'active';
  private readonly createdDirs = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(readonly projectRoot: string, backupDir: string, sessionId: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.backupDir = backupDir;
    this.sessionId = sessionId;
  }

  static async begin(projectRoot: string): Promise<WorkspaceMutationTransaction> {
    await recoverIncompleteMutations(projectRoot);
    const release = await acquireLock(projectRoot);
    try {
      const key = sessionKey(projectRoot);
      if (activeTransactions.has(key)) {
        throw new Error(`Mutation transaction already active for ${projectRoot}`);
      }
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

  private async persistJournal(state?: MutationJournal['state']): Promise<void> {
    if (state) this.journalState = state;
    const journal: MutationJournal = {
      sessionId: this.sessionId,
      projectRoot: this.projectRoot,
      backupDir: this.backupDir,
      records: this.records,
      startedAt: Date.now(),
      state: this.journalState,
    };
    const finalPath = journalPath(this.projectRoot);
    const tempPath = `${finalPath}.${this.sessionId}.tmp`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tempPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8');
    await atomicReplace(tempPath, finalPath);
  }

  private async clearJournal(): Promise<void> {
    try {
      await fs.promises.unlink(journalPath(this.projectRoot));
    } catch {
      // no journal
    }
  }

  async writeText(absolutePath: string, content: string, opts?: MutationWriteOpts): Promise<void> {
    const run = () => this.writeTextInternal(absolutePath, content, opts);
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.then(
      () => {},
      () => {},
    );
    return chained;
  }

  private async writeTextInternal(absolutePath: string, content: string, opts?: MutationWriteOpts): Promise<void> {
    this.ensureOpen();
    assertPathContained(this.projectRoot, absolutePath);
    if (!isExtensionManagedMutationPath(this.projectRoot, absolutePath)) {
      throw new Error(`Mutation path is not extension-managed: ${absolutePath}`);
    }
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

    const resolved = path.resolve(absolutePath);
    const existedBefore = await fileExists(resolved);
    let previous = '';
    if (existedBefore) {
      previous = await fs.promises.readFile(resolved, 'utf-8');
      if (previous === content) return;
    }

    const relativeTargetPath = relativeFromRoot(this.projectRoot, resolved);
    const record: MutationRecord = {
      absoluteTargetPath: resolved,
      relativeTargetPath,
      existedBefore,
      status: 'pending',
      createdDirs: [],
    };

    if (existedBefore) {
      const backupPath = path.join(this.backupDir, backupFileName(relativeTargetPath));
      await fs.promises.writeFile(backupPath, previous, 'utf-8');
      record.backupPath = backupPath;
      record.originalSha256 = sha256(previous);
    }

    const dir = path.dirname(resolved);
    if (!(await fileExists(dir))) {
      await fs.promises.mkdir(dir, { recursive: true });
      record.createdDirs.push(dir);
      this.createdDirs.add(dir);
    }

    const recordIndex = this.records.length;
    this.records.push(record);

    const tempPath = `${resolved}.ue58cursor.${this.sessionId}.${recordIndex}.tmp`;
    try {
      await this.persistJournal();
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await atomicReplace(tempPath, resolved);
      record.postWriteSha256 = sha256Buffer(Buffer.from(content, 'utf8'));
      record.status = 'committed';
      await this.persistJournal();
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
      await this.rollbackRecordsFrom(recordIndex);
      throw err;
    }
  }

  async writeJson(absolutePath: string, value: unknown, opts?: MutationWriteOpts): Promise<void> {
    await this.writeText(absolutePath, JSON.stringify(value, null, 2) + '\n', opts);
  }

  async writeBytes(absolutePath: string, content: Buffer, opts?: MutationWriteOpts): Promise<void> {
    const run = () => this.writeBytesInternal(absolutePath, content, opts);
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.then(
      () => {},
      () => {},
    );
    return chained;
  }

  private async writeBytesInternal(absolutePath: string, content: Buffer, opts?: MutationWriteOpts): Promise<void> {
    this.ensureOpen();
    assertPathContained(this.projectRoot, absolutePath);
    if (!isExtensionManagedMutationPath(this.projectRoot, absolutePath)) {
      throw new Error(`Mutation path is not extension-managed: ${absolutePath}`);
    }
    const policy = resolvePolicy(absolutePath, opts);
    if (policy === 'forbidden') {
      throw new Error(`Mutation forbidden: ${absolutePath}`);
    }
    if (policy === 'consentRequired' && !opts?.consentGranted) {
      throw new Error(`Consent required: ${absolutePath}`);
    }

    const resolved = path.resolve(absolutePath);
    const existedBefore = await fileExists(resolved);
    let previous = Buffer.alloc(0);
    if (existedBefore) {
      previous = await fs.promises.readFile(resolved);
      if (previous.equals(content)) return;
    }

    const relativeTargetPath = relativeFromRoot(this.projectRoot, resolved);
    const record: MutationRecord = {
      absoluteTargetPath: resolved,
      relativeTargetPath,
      existedBefore,
      status: 'pending',
      createdDirs: [],
    };

    if (existedBefore) {
      const backupPath = path.join(this.backupDir, backupFileName(relativeTargetPath));
      await fs.promises.writeFile(backupPath, previous);
      record.backupPath = backupPath;
      record.originalSha256 = sha256Buffer(previous);
    }

    const dir = path.dirname(resolved);
    if (!(await fileExists(dir))) {
      await fs.promises.mkdir(dir, { recursive: true });
      record.createdDirs.push(dir);
      this.createdDirs.add(dir);
    }

    const recordIndex = this.records.length;
    this.records.push(record);

    const tempPath = `${resolved}.ue58cursor.${this.sessionId}.${recordIndex}.tmp`;
    try {
      await this.persistJournal();
      await fs.promises.writeFile(tempPath, content);
      await atomicReplace(tempPath, resolved);
      record.postWriteSha256 = sha256Buffer(content);
      record.status = 'committed';
      await this.persistJournal();
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
      await this.rollbackRecordsFrom(recordIndex);
      throw err;
    }
  }

  private ensureOpen(): void {
    if (this.committed) throw new Error('Transaction already committed');
    if (this.rolledBack) throw new Error('Transaction already rolled back');
  }

  private async rollbackRecordsFrom(startIndex: number): Promise<void> {
    const slice = this.records.slice(startIndex).reverse();
    for (const record of slice) {
      if (record.existedBefore && record.backupPath) {
        const currentHash = await fileSha256(record.absoluteTargetPath);
        if (
          record.postWriteSha256
          && currentHash !== undefined
          && currentHash !== record.postWriteSha256
        ) {
          continue;
        }
        const content = await fs.promises.readFile(record.backupPath);
        await fs.promises.writeFile(record.absoluteTargetPath, content);
      } else if (!record.existedBefore && (await fileExists(record.absoluteTargetPath))) {
        const currentHash = await fileSha256(record.absoluteTargetPath);
        if (currentHash !== undefined && record.postWriteSha256 && currentHash !== record.postWriteSha256) {
          continue;
        }
        await fs.promises.unlink(record.absoluteTargetPath);
      }
      await removeEmptyDirs(record.createdDirs);
    }
    this.records.splice(startIndex);
    if (this.records.length > 0) {
      await this.persistJournal();
    } else {
      await this.clearJournal();
    }
  }

  async commit(): Promise<MutationCommitResult> {
    this.ensureOpen();
    await this.writeChain;
    await this.persistJournal('committing');
    this.committed = true;
    for (const record of this.records) record.status = 'committed';
    await this.persistJournal('committed');
    activeTransactions.delete(sessionKey(this.projectRoot));
    try {
      await this.clearJournal();
    } catch {
      // Journal records committed state; recovery will clear without rollback.
    }
    return {
      ok: true,
      changedFiles: this.records.map((r) => r.relativeTargetPath),
    };
  }

  async rollback(): Promise<MutationRollbackResult> {
    if (this.committed) {
      return { ok: false, restoredFiles: [], deletedFiles: [], failedFiles: ['transaction already committed'] };
    }
    await this.writeChain;
    this.rolledBack = true;
    await this.persistJournal('rollingBack');
    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    const failedFiles: string[] = [];
    const conflictFiles: string[] = [];

    for (const record of [...this.records].reverse()) {
      try {
        if (record.existedBefore && record.backupPath) {
          const currentHash = await fileSha256(record.absoluteTargetPath);
          if (
            record.postWriteSha256
            && currentHash !== undefined
            && currentHash !== record.postWriteSha256
          ) {
            conflictFiles.push(record.relativeTargetPath);
            continue;
          }
          const content = await fs.promises.readFile(record.backupPath);
          await fs.promises.writeFile(record.absoluteTargetPath, content);
          restoredFiles.push(record.relativeTargetPath);
        } else if (!record.existedBefore && (await fileExists(record.absoluteTargetPath))) {
          const currentHash = await fileSha256(record.absoluteTargetPath);
          if (currentHash !== undefined && record.postWriteSha256 && currentHash !== record.postWriteSha256) {
            conflictFiles.push(record.relativeTargetPath);
            continue;
          }
          await fs.promises.unlink(record.absoluteTargetPath);
          deletedFiles.push(record.relativeTargetPath);
        }
        await removeEmptyDirs(record.createdDirs);
      } catch {
        failedFiles.push(record.relativeTargetPath);
      }
    }

    const ok = failedFiles.length === 0 && conflictFiles.length === 0;
    if (!ok) {
      await this.persistJournal('rollback-conflict');
      activeTransactions.delete(sessionKey(this.projectRoot));
      return {
        ok: false,
        restoredFiles,
        deletedFiles,
        failedFiles,
        conflictFiles,
      };
    }

    this.records.length = 0;
    activeTransactions.delete(sessionKey(this.projectRoot));
    await this.clearJournal();
    return {
      ok: true,
      restoredFiles,
      deletedFiles,
      failedFiles,
      conflictFiles,
    };
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

/** @internal Simulates a crash after journal persistence without commit. */
export function __testAbandonActiveTransaction(projectRoot: string): void {
  activeTransactions.delete(sessionKey(projectRoot));
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

export async function mutateBytes(
  tx: WorkspaceMutationTransaction | undefined,
  projectRoot: string,
  filePath: string,
  content: Buffer,
  opts?: MutationWriteOpts,
): Promise<void> {
  if (tx) {
    await tx.writeBytes(filePath, content, opts);
    return;
  }
  assertPathContained(projectRoot, filePath);
  if (!isExtensionManagedMutationPath(projectRoot, filePath)) {
    throw new Error(`Mutation path is not extension-managed: ${filePath}`);
  }
  const policy = resolvePolicy(filePath, opts);
  if (policy === 'forbidden') throw new Error(`Mutation forbidden: ${filePath}`);
  if (policy === 'consentRequired' && !opts?.consentGranted) {
    throw new Error(`Consent required: ${filePath}`);
  }
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.ue58cursor.tmp`;
  await fs.promises.writeFile(tempPath, content);
  await atomicReplace(tempPath, filePath);
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

/** Roll back any active or orphaned journal state, then clear the session map entry. */
export async function forceRollbackAndClear(projectRoot: string): Promise<MutationRollbackResult> {
  const tx = activeTransactions.get(sessionKey(projectRoot));
  if (tx) {
    return tx.rollback();
  }
  const journal = await loadJournal(projectRoot);
  if (!journal) {
    return { ok: true, restoredFiles: [], deletedFiles: [], failedFiles: [] };
  }
  return rollbackJournalRecords(projectRoot, journal);
}

/** @deprecated Use forceRollbackAndClear — this dropped rollback guarantees. */
export function clearMutationSession(projectRoot: string): void {
  activeTransactions.delete(sessionKey(projectRoot));
}

/** Drop in-memory transaction handles on extension shutdown (journals remain for recovery). */
export function releaseActiveMutationSessions(): void {
  activeTransactions.clear();
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
