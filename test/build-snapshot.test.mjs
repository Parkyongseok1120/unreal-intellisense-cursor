import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function makeProject(root, name = 'TestProject') {
  const rspDir = path.join(root, 'Intermediate', 'Build', 'Win64', 'x64', 'UnrealEditor', 'Development', name);
  fs.mkdirSync(rspDir, { recursive: true });
  fs.writeFileSync(path.join(rspDir, `${name}.Shared.rsp`), '/DTEST=1\n/I "."\n');
  fs.writeFileSync(path.join(root, `${name}.uproject`), JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8' }) + '\n');
  return {
    name,
    projectRoot: root,
    uprojectPath: path.join(root, `${name}.uproject`),
    engineAssociation: '5.8',
    modules: [],
  };
}

const buildSnapshot = loadTsModule('src/projectModel/buildSnapshot.ts', {
  './projectModelService': () => ({
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
    compareActionHashes: (expected, actual, options) => {
      const mode = options?.mode ?? 'flags';
      const actualByFile = new Map(actual.map((a) => [a.file.toLowerCase(), a]));
      let matched = 0;
      for (const exp of expected) {
        const act = actualByFile.get(exp.file.toLowerCase());
        if (act && act.hash === exp.hash) matched++;
      }
      const total = expected.length;
      const parity = total === 0 ? 0 : matched / total;
      let tuLinked = 0;
      if (mode === 'tu' || mode === 'both') {
        for (const exp of expected) {
          if (actualByFile.has(exp.file.toLowerCase())) tuLinked++;
        }
      }
      const tuTotal = expected.length;
      const tuRate = tuTotal === 0 ? 0 : tuLinked / tuTotal;
      if (mode === 'tu') return { matched: tuLinked, total: tuTotal, parity: tuRate, tuLinked, tuTotal, tuRate };
      if (mode === 'both') return { matched, total, parity, tuLinked, tuTotal, tuRate };
      return { matched, total, parity };
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
  '../uht/uhtRunner': () => ({
    findUhtManifest: async () => undefined,
  }),
});

describe('buildSnapshot', () => {
  it('marks synthetic compile db and saves snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-'));
    const project = makeProject(root);
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

    const snap = await buildSnapshot.buildCompileSnapshot({ project });

    assert.equal(snap.snapshotVersion, 3);
    assert.equal(snap.synthetic, true);
    assert.equal(snap.provenance, 'synthetic-buildcs');
    assert.ok(snap.snapshotKey.includes('TestProject'));
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
      snapshotKey: 'P/Win64/Development/UnrealEditor/x64',
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
      flagParity: { matched: 0, total: 0, parity: 0 },
      tuLinkage: { linked: 0, total: 0, rate: 0 },
    };
    await buildSnapshot.saveBuildSnapshot(root, snap);
    const status = await buildSnapshot.snapshotFreshness(root);
    assert.equal(status, 'partial');
  });

  it('invalidates a snapshot when a new Build.cs input is added', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-snap-inventory-'));
    const project = makeProject(root, 'One');
    fs.mkdirSync(path.join(root, 'Source', 'One'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Source', 'One', 'One.Build.cs'), 'public class One {}\n');
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]');

    const snap = await buildSnapshot.buildCompileSnapshot({ project });
    assert.equal(await buildSnapshot.inputsStillValid(snap), true);

    fs.mkdirSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Two.uplugin'), '{}\n');
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two', 'Two.Build.cs'), 'public class Two {}\n');
    assert.equal(await buildSnapshot.inputsStillValid(snap), false);
  });
});
