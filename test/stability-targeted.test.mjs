import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(commandBridgeSrc.includes('bodyBytes += chunk.length'));
    assert.ok(commandBridgeSrc.includes('res.writeHead(413'));
    assert.match(commandBridgeSrc, /writeBridgeFile[\s\S]*?catch[\s\S]*?closeServer/s);
  });

  it('aborts active RPC controllers on EditorBridge dispose', () => {
    assert.ok(editorBridgeClientSrc.includes('activeRpcControllers'));
    assert.ok(editorBridgeClientSrc.includes('connectionGeneration++'));
    assert.ok(editorBridgeClientSrc.includes('for (const controller of this.activeRpcControllers) controller.abort()'));
    assert.ok(editorBridgeClientSrc.includes('Superseded connection'));
    assert.ok(editorBridgeClientSrc.includes('private isDisposed(): boolean'));
  });

  it('skips full reconnect when connected descriptor identity is unchanged', () => {
    assert.ok(reconnectWatcherSrc.includes('bridge.ping'));
    assert.ok(reconnectWatcherSrc.includes('descriptorKey === state.lastDescriptorKey'));
    assert.ok(editorBridgeClientSrc.includes('async ping(timeoutMs'));
  });

  it('serializes bridge setup through setupInflight promise map', () => {
    assert.ok(bridgeSetupSrc.includes('setupInflight'));
    assert.ok(bridgeSetupSrc.includes('if (inflight)'));
    assert.ok(bridgeSetupSrc.includes('setupInflight.set(key, run)'));
    assert.ok(bridgeSetupSrc.includes('authoritativeBridge: true'));
  });

  it('reschedules source watcher flush when events arrive during in-flight batch', () => {
    assert.ok(sourceWatcherSrc.includes('reflectionReschedule'));
    assert.ok(sourceWatcherSrc.includes('tuReschedule'));
    assert.ok(sourceWatcherSrc.includes('compileReschedule'));
    assert.match(sourceWatcherSrc, /finally[\s\S]*reflectionReschedule[\s\S]*flushReflectionBatch/s);
  });
});
