import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const mutation = loadTsModule('src/platform/workspaceMutation.ts');
const assetIndex = loadTsModule('src/assets/assetIndex.ts');

const editorBridgeClientSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/editorBridge/editorBridgeClient.ts'),
  'utf-8',
);
const commandBridgeSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/mcp/commandBridge.ts'),
  'utf-8',
);
const bridgeSetupSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/editorBridge/bridgeConnectedSetup.ts'),
  'utf-8',
);
const reconnectWatcherSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/editorBridge/bridgeReconnectWatcher.ts'),
  'utf-8',
);
const sourceWatcherSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/detection/sourceWatcher.ts'),
  'utf-8',
);
const assetIndexSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/assets/assetIndex.ts'),
  'utf-8',
);
const processSrc = fs.readFileSync(
  path.join(process.cwd(), 'src/platform/process.ts'),
  'utf-8',
);

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

describe('stability targeted — workspaceMutation', () => {
  it('rejects concurrent begin() for the same project root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-concurrent-begin-'));
    const first = mutation.WorkspaceMutationTransaction.begin(root);
    await assert.rejects(
      () => mutation.WorkspaceMutationTransaction.begin(root),
      /already active/,
    );
    const tx = await first;
    await tx.rollback();
  });

  it('preserves journal on rollback conflict instead of deleting recovery data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-rollback-conflict-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ a: 1 }, null, 2) + '\n', 'utf-8');

    const tx = await mutation.WorkspaceMutationTransaction.begin(root);
    await tx.writeText(filePath, JSON.stringify({ a: 2 }, null, 2) + '\n');
    await fs.promises.writeFile(filePath, JSON.stringify({ a: 999 }, null, 2) + '\n', 'utf-8');

    const result = await tx.rollback();
    assert.equal(result.ok, false);
    assert.ok(result.conflictFiles?.length);

    const journalPath = path.join(root, '.ue5_8cursor', 'mutation-journal.json');
    assert.equal(fs.existsSync(journalPath), true);
    const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf-8'));
    assert.equal(journal.state, 'rollback-conflict');
  });

  it('clears committed journal on recovery without rolling back files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-committed-journal-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ committed: true }, null, 2) + '\n', 'utf-8');

    const journalPath = path.join(root, '.ue5_8cursor', 'mutation-journal.json');
    await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.promises.writeFile(
      journalPath,
      JSON.stringify({
        sessionId: 'abc',
        projectRoot: root,
        backupDir: path.join(root, '.ue5_8cursor', 'backups', '1'),
        records: [],
        startedAt: Date.now(),
        state: 'committed',
      }, null, 2) + '\n',
      'utf-8',
    );

    const recovery = await mutation.recoverIncompleteMutations(root);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.rolledBack, false);
    assert.equal(fs.existsSync(journalPath), false);
    const content = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    assert.equal(content.committed, true);
  });

  it('persists committed journal state before clearing on commit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-commit-journal-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ a: 1 }, null, 2) + '\n', 'utf-8');

    const tx = await mutation.WorkspaceMutationTransaction.begin(root);
    await tx.writeText(filePath, JSON.stringify({ a: 2 }, null, 2) + '\n');
    await tx.commit();

    const journalPath = path.join(root, '.ue5_8cursor', 'mutation-journal.json');
    assert.equal(fs.existsSync(journalPath), false);

    const recovery = await mutation.recoverIncompleteMutations(root);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.rolledBack, false);
    const content = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    assert.equal(content.a, 2);
  });

  it('recovery preserves journal when orphan rollback hits user conflict', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-recovery-conflict-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    const backupDir = path.join(root, '.ue5_8cursor', 'backups', 'crash');
    await fs.promises.mkdir(backupDir, { recursive: true });

    const original = JSON.stringify({ a: 1 }, null, 2) + '\n';
    const written = JSON.stringify({ a: 2 }, null, 2) + '\n';
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, written, 'utf-8');
    const backupPath = path.join(backupDir, 'vscode-settings.json');
    await fs.promises.writeFile(backupPath, original, 'utf-8');
    await fs.promises.writeFile(filePath, JSON.stringify({ a: 999 }, null, 2) + '\n', 'utf-8');

    const journalPath = path.join(root, '.ue5_8cursor', 'mutation-journal.json');
    await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.promises.writeFile(
      journalPath,
      JSON.stringify({
        sessionId: 'crash',
        projectRoot: root,
        backupDir,
        state: 'active',
        records: [{
          absoluteTargetPath: filePath,
          relativeTargetPath: '.vscode/settings.json',
          existedBefore: true,
          backupPath,
          postWriteSha256: sha256Text(written),
          status: 'pending',
          createdDirs: [],
        }],
        startedAt: Date.now(),
      }, null, 2) + '\n',
      'utf-8',
    );

    const recovery = await mutation.recoverIncompleteMutations(root);
    assert.equal(recovery.conflict, true);
    assert.equal(recovery.rolledBack, false);
    assert.equal(fs.existsSync(journalPath), true);
    const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf-8'));
    assert.equal(journal.state, 'rollback-conflict');
  });

  it('clears committing journal on recovery without rolling back files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-committing-journal-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ kept: true }, null, 2) + '\n', 'utf-8');

    const journalPath = path.join(root, '.ue5_8cursor', 'mutation-journal.json');
    await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.promises.writeFile(
      journalPath,
      JSON.stringify({
        sessionId: 'committing',
        projectRoot: root,
        backupDir: path.join(root, '.ue5_8cursor', 'backups', '1'),
        records: [{ absoluteTargetPath: filePath, relativeTargetPath: '.vscode/settings.json', existedBefore: true, status: 'committed', createdDirs: [] }],
        startedAt: Date.now(),
        state: 'committing',
      }, null, 2) + '\n',
      'utf-8',
    );

    const recovery = await mutation.recoverIncompleteMutations(root);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.rolledBack, false);
    assert.equal(fs.existsSync(journalPath), false);
    const content = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    assert.equal(content.kept, true);
  });
});

describe('stability targeted — asset authoritative sync', () => {
  it('replaces bridge entries and removes stale bridge-only assets on empty sync', () => {
    const disk = [
      {
        diskPath: 'C:/P/Content/Foo.uasset',
        assetPath: '/Game/Foo.Foo',
        fileName: 'Foo',
        assetName: 'Foo',
        source: 'content-scan',
      },
      {
        diskPath: '',
        assetPath: '/Game/OldBridge.OldBridge',
        fileName: 'OldBridge',
        assetName: 'OldBridge',
        source: 'bridge',
        confidence: 'authoritative',
      },
    ];
    const replaced = assetIndex.replaceBridgeAuthoritative(disk, []);
    assert.equal(replaced.some((e) => e.assetPath === '/Game/OldBridge.OldBridge'), false);
    assert.equal(replaced.some((e) => e.assetPath === '/Game/Foo.Foo'), true);
  });

  it('marks bridge assets authoritative with class metadata', () => {
    const replaced = assetIndex.replaceBridgeAuthoritative([], [
      { assetPath: '/Game/BP_Test.BP_Test', className: 'Actor' },
    ]);
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].source, 'bridge');
    assert.equal(replaced[0].confidence, 'authoritative');
    assert.equal(replaced[0].packageClass, 'Actor');
  });
});

describe('stability targeted — lifecycle contracts', () => {
  it('closes command bridge server when descriptor write fails', () => {
    assert.ok(commandBridgeSrc.includes('await this.closeServer(server)'));
    assert.ok(commandBridgeSrc.includes('startPromise'));
    assert.ok(commandBridgeSrc.includes('private disposed = false'));
    assert.ok(commandBridgeSrc.includes('if (this.disposed)'));
    assert.ok(commandBridgeSrc.includes('bodyBytes += chunk.length'));
    assert.ok(commandBridgeSrc.includes('res.writeHead(413'));
    assert.match(commandBridgeSrc, /writeBridgeFile[\s\S]*?catch[\s\S]*?closeServer/s);
  });

  it('aborts active RPC controllers on EditorBridge dispose', () => {
    assert.ok(editorBridgeClientSrc.includes('activeRpcControllers'));
    assert.ok(editorBridgeClientSrc.includes('connectionGeneration++'));
    assert.ok(editorBridgeClientSrc.includes('abortActiveRpcs()'));
    assert.ok(editorBridgeClientSrc.includes('Superseded connection'));
    assert.ok(editorBridgeClientSrc.includes('private isDisposed(): boolean'));
  });

  it('skips full reconnect when connected descriptor identity is unchanged', () => {
    assert.ok(reconnectWatcherSrc.includes('bridge.ping'));
    assert.ok(reconnectWatcherSrc.includes('descriptorKey === state.lastDescriptorKey'));
    assert.ok(reconnectWatcherSrc.includes('pingFailStreak'));
    assert.ok(editorBridgeClientSrc.includes('async ping(timeoutMs'));
  });

  it('serializes bridge setup through setupInflight promise map', () => {
    assert.ok(bridgeSetupSrc.includes('setupInflight'));
    assert.ok(bridgeSetupSrc.includes('setupEpochByProject'));
    assert.ok(bridgeSetupSrc.includes('if (inflight)'));
    assert.ok(bridgeSetupSrc.includes('setupInflight.set(key, run)'));
    assert.ok(bridgeSetupSrc.includes('authoritativeBridge: true'));
    assert.ok(bridgeSetupSrc.includes('currentSetupEpoch(key) !== deltaEpoch'));
  });

  it('serializes asset index writes through per-project lock', () => {
    assert.ok(assetIndexSrc.includes('withAssetIndexLock'));
    assert.match(assetIndexSrc, /applyBridgeAssetDelta[\s\S]*withAssetIndexLock/s);
    assert.match(assetIndexSrc, /refreshAssetIndex[\s\S]*withAssetIndexLock/s);
  });

  it('decodes process output with StringDecoder for UTF-8 chunk boundaries', () => {
    assert.ok(processSrc.includes("import { StringDecoder } from 'string_decoder'"));
    assert.ok(processSrc.includes('stdoutDecoder.write(data)'));
    assert.ok(processSrc.includes('stderrDecoder.write(data)'));
    assert.ok(processSrc.includes('stdoutDecoder.end()'));
  });

  it('reschedules source watcher flush when events arrive during in-flight batch', () => {
    assert.ok(sourceWatcherSrc.includes('reflectionReschedule'));
    assert.ok(sourceWatcherSrc.includes('tuReschedule'));
    assert.ok(sourceWatcherSrc.includes('compileReschedule'));
    assert.match(sourceWatcherSrc, /finally[\s\S]*reflectionReschedule[\s\S]*flushReflectionBatch/s);
  });

  it('persists committing journal before in-memory commit and releases sessions on deactivate', () => {
    const mutationSrc = fs.readFileSync(path.join(process.cwd(), 'src/platform/workspaceMutation.ts'), 'utf-8');
    const extensionSrc = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf-8');
    assert.match(mutationSrc, /await this\.persistJournal\('committing'\)[\s\S]*this\.committed = true/s);
    assert.ok(mutationSrc.includes('releaseActiveMutationSessions'));
    assert.ok(extensionSrc.includes('releaseActiveMutationSessions()'));
    assert.ok(commandBridgeSrc.includes('this.disposed) return'));
    assert.ok(assetIndexSrc.includes('await fs.promises.rename(tempPath, filePath)'));
  });
});
