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

    assert.equal(snap.synthetic, true);
    assert.equal(snap.provenance, 'buildcs');
    assert.ok(snap.fingerprint.length > 0);

    const saved = await buildSnapshot.saveBuildSnapshot(root, snap);
    assert.ok(fs.existsSync(saved));

    const loaded = await buildSnapshot.loadBuildSnapshot(root);
    assert.equal(loaded?.fingerprint, snap.fingerprint);
  });

  it('reports partial freshness for synthetic snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-fresh-'));
    const snap = {
      version: 1,
      projectRoot: root,
      synthetic: true,
      provenance: 'buildcs',
      fingerprint: 'deadbeef',
      updatedAt: new Date().toISOString(),
      compileActions: [],
      rspPaths: [],
    };
    await buildSnapshot.saveBuildSnapshot(root, snap);
    const status = await buildSnapshot.snapshotFreshness(root);
    assert.equal(status, 'partial');
  });
});
