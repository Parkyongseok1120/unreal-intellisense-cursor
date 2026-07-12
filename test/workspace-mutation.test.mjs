import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const mutation = loadTsModule('src/platform/workspaceMutation.ts');

describe('workspaceMutation transaction', () => {
  it('rolls back multiple files to exact paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-tx-'));
    const settingsPath = path.join(root, '.vscode', 'settings.json');
    const mcpPath = path.join(root, '.cursor', 'mcp.json');

    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(mcpPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify({ a: 1 }, null, 2) + '\n', 'utf-8');
    await fs.promises.writeFile(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf-8');

    const tx = await mutation.WorkspaceMutationTransaction.begin(root);
    await tx.writeText(settingsPath, JSON.stringify({ a: 2 }, null, 2) + '\n');
    await tx.writeText(mcpPath, JSON.stringify({ mcpServers: { x: {} } }, null, 2) + '\n');
    await tx.rollback();

    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
    const mcp = JSON.parse(await fs.promises.readFile(mcpPath, 'utf-8'));
    assert.equal(settings.a, 1);
    assert.deepEqual(mcp.mcpServers, {});
  });

  it('deletes newly created files on rollback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-tx-new-'));
    const newPath = path.join(root, '.vscode', 'settings.json');
    const tx = await mutation.WorkspaceMutationTransaction.begin(root);
    await tx.writeText(newPath, JSON.stringify({ fresh: true }, null, 2) + '\n');
    await tx.rollback();
    assert.equal(fs.existsSync(newPath), false);
  });

  it('rejects policy downgrade attempts', () => {
    const uproject = 'C:/P/Game.uproject';
    assert.equal(mutation.canOverridePolicy(uproject, 'auto'), false);
    assert.equal(mutation.canOverridePolicy(uproject, 'consentRequired'), true);
  });

  it('does not write settings.json at project root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-tx-root-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await mutation.mutateText(undefined, root, filePath, JSON.stringify({ ok: true }, null, 2) + '\n');
    assert.equal(fs.existsSync(path.join(root, 'settings.json')), false);
    assert.equal(fs.existsSync(filePath), true);
  });
});

describe('workspaceMutation legacy API', () => {
  it('writes atomically and rolls back on invalid JSON target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-mutation-'));
    const filePath = path.join(root, '.vscode', 'settings.json');
    await mutation.writeProjectFileAtomic({
      projectRoot: root,
      filePath,
      content: JSON.stringify({ ok: true }, null, 2),
      policy: 'auto',
    });

    const invalid = await mutation.writeProjectFileAtomic({
      projectRoot: root,
      filePath,
      content: '{not json',
      policy: 'auto',
    });
    assert.equal(invalid.changed, false);
    assert.match(invalid.error ?? '', /Invalid JSON/);

    const restored = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    assert.equal(restored.ok, true);
  });

  it('requires consent for Build.cs mutation by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-mutation-'));
    const filePath = path.join(root, 'Source', 'Game', 'Game.Build.cs');
    const result = await mutation.writeProjectFileAtomic({
      projectRoot: root,
      filePath,
      content: 'class Game {}',
      policy: 'consentRequired',
    });
    assert.equal(result.changed, false);
    assert.match(result.error ?? '', /consent/i);
  });

  it('removes only managed explorer patterns', () => {
    const existing = { '**/.git': true, Binaries: true, MyCustom: true };
    const managed = { Binaries: true, Intermediate: true };
    const next = mutation.removeManagedExplorerPatterns(existing, managed);
    assert.equal(next['**/.git'], true);
    assert.equal(next.MyCustom, true);
    assert.equal(next.Binaries, undefined);
  });
});
