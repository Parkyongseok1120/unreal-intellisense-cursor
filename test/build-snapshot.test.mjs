import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const buildSnapshot = loadTsModule('src/projectModel/buildSnapshot.ts', {
  '../projectModel/projectModelService': () => ({
    collectCompileActionsFromProject: async (root) => {
      const raw = await fs.promises.readFile(path.join(root, 'compile_commands.json'), 'utf-8');
      const jsonStart = raw.indexOf('[');
      const db = JSON.parse(raw.slice(jsonStart));
      return db.map((e) => ({
        file: e.file,
        arguments: e.arguments ?? [],
        hash: 'abc',
      }));
    },
    compareActionHashes: (expected, actual) => ({
      matched: Math.min(expected.length, actual.length),
      total: Math.max(expected.length, actual.length),
      parity: expected.length && actual.length ? 1 : 0,
    }),
  }),
  '../platform/paths': () => ({
    fileExists: async (p) => {
      try {
        await fs.promises.access(p);
        return true;
      } catch {
        return false;
      }
    },
  }),
});

describe('buildSnapshot', () => {
  it('marks synthetic compile db and saves snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-'));
    fs.writeFileSync(
      path.join(root, 'compile_commands.json'),
      '// UE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1\n' +
        JSON.stringify([
          {
            file: 'C:/P/Foo.cpp',
            arguments: ['clang++', 'C:/P/Foo.cpp'],
          },
        ]),
    );

    const snap = await buildSnapshot.buildCompileSnapshot({
      projectRoot: root,
      engineAssociation: '5.8',
    });

    assert.equal(snap.snapshotVersion, 3);
    assert.equal(snap.synthetic, true);
    assert.equal(snap.provenance, 'synthetic-buildcs');
    assert.ok(snap.fingerprint.length > 0);
    assert.ok(Array.isArray(snap.ideActions));
    assert.ok(Array.isArray(snap.authoritativeActions));
    assert.ok(snap.parity);

    const saved = await buildSnapshot.saveBuildSnapshot(root, snap);
    assert.ok(fs.existsSync(saved));

    const loaded = await buildSnapshot.loadBuildSnapshot(root);
    assert.equal(loaded?.fingerprint, snap.fingerprint);
  });

  it('reports partial freshness for synthetic snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-fresh-'));
    const snap = {
      snapshotVersion: 3,
      projectRoot: root,
      synthetic: true,
      provenance: 'synthetic-buildcs',
      fingerprint: 'deadbeef',
      updatedAt: new Date().toISOString(),
      authoritativeActions: [],
      ideActions: [],
      rspPaths: [],
      inputs: [],
      parity: { matched: 0, total: 0, parity: 0 },
    };
    await buildSnapshot.saveBuildSnapshot(root, snap);
    const status = await buildSnapshot.snapshotFreshness(root);
    assert.equal(status, 'partial');
  });

  it('invalidates a snapshot when a new Build.cs input is added', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-inventory-'));
    fs.mkdirSync(path.join(root, 'Source', 'One'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Source', 'One', 'One.Build.cs'), 'public class One {}\n');
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]');

    const snap = await buildSnapshot.buildCompileSnapshot({ projectRoot: root });
    assert.equal(await buildSnapshot.inputsStillValid(snap), true);

    fs.mkdirSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Two.uplugin'), '{}\n');
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two', 'Two.Build.cs'), 'public class Two {}\n');
    assert.equal(await buildSnapshot.inputsStillValid(snap), false);
  });
});
