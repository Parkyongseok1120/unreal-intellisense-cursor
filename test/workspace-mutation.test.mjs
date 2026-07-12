import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const mutation = loadTsModule('src/platform/workspaceMutation.ts');

describe('workspaceMutation', () => {
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

  it('forbids Build.cs mutation by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-mutation-'));
    const filePath = path.join(root, 'Source', 'Game', 'Game.Build.cs');
    const result = await mutation.writeProjectFileAtomic({
      projectRoot: root,
      filePath,
      content: 'class Game {}',
      policy: 'forbidden',
    });
    assert.equal(result.changed, false);
    assert.match(result.error ?? '', /forbidden/i);
  });

  it('removes only managed explorer patterns', () => {
    const existing = { '**/.git': true, Binaries: true, 'MyCustom': true };
    const managed = { Binaries: true, Intermediate: true };
    const next = mutation.removeManagedExplorerPatterns(existing, managed);
    assert.deepEqual(next, { '**/.git': true, MyCustom: true });
  });
});
