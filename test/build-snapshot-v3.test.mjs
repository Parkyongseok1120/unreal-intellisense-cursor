import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const snapshotKey = loadTsModule('src/projectModel/snapshotKey.ts', {
  '../build/ubt': () => ({
    resolveTargetName: (_project, targetType) => (targetType === 'Editor' ? 'UnrealEditor' : 'Game'),
  }),
});

const rspImporter = loadTsModule('src/projectModel/rspActionImporter.ts');
const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../parsers/moduleLayout': () => ({ discoverModuleLayouts: async () => [] }),
  '../platform/paths': () => ({ fileExists: async (p) => fs.existsSync(p) }),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  '../uht/reflectionIndex': () => ({ buildReflectionIndex: async () => [] }),
  '../uht/uhtRunner': () => ({ findUhtManifest: async () => undefined, parseUhtManifestInputFiles: async () => [] }),
  '../platform/dataDir': () => ({ ensureDataDir: async (root) => path.join(root, '.ue5_8cursor') }),
});

function loadBuildSnapshot() {
  return loadTsModule('src/projectModel/buildSnapshot.ts', {
    '../uht/uhtRunner': () => ({ findUhtManifest: async () => undefined }),
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
}

function makeRspTree(root, { projectName = 'ParityProj', platform = 'Win64', arch = 'x64', target = 'UnrealEditor', config = 'Development' } = {}) {
  const rspDir = path.join(root, 'Intermediate', 'Build', platform, arch, target, config, projectName);
  fs.mkdirSync(rspDir, { recursive: true });
  const shared = path.join(rspDir, `${projectName}.Shared.rsp`);
  fs.writeFileSync(shared, ['/DPLATFORM=1', '/I "."', '/std:c++20'].join('\n') + '\n');
  const cppPath = path.join(root, 'Source', projectName, 'Private', 'Main.cpp');
  fs.mkdirSync(path.dirname(cppPath), { recursive: true });
  fs.writeFileSync(cppPath, 'int main() { return 0; }\n');
  const objRsp = path.join(rspDir, `Module.${projectName}.cpp.obj.rsp`);
  fs.writeFileSync(
    objRsp,
    [`@${shared}`, `/Tc"${cppPath}"`, '/Fo"ignored.obj"'].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(root, `${projectName}.uproject`), JSON.stringify({ FileVersion: 3 }) + '\n');
  return { rspDir, shared, objRsp, cppPath };
}

describe('buildSnapshot v3', () => {
  it('rejects v2 snapshots without snapshotKey', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-v2-'));
    const dir = path.join(root, '.ue5_8cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'build-snapshot.json'),
      JSON.stringify({
        version: 2,
        projectRoot: root,
        synthetic: false,
        fingerprint: 'old',
        compileActions: [],
      }) + '\n',
    );
    const loaded = await buildSnapshot.loadBuildSnapshot(root);
    assert.equal(loaded, undefined);
  });

  it('resolves composite snapshotKey from settings', () => {
    const key = snapshotKey.resolveSnapshotKey({
      project: { name: 'Demo', projectRoot: 'C:/P', uprojectPath: 'C:/P/Demo.uproject', engineAssociation: '5.8', modules: [] },
      targetType: 'Editor',
      platform: 'Win64',
      configuration: 'Development',
      architecture: 'x64',
    });
    assert.equal(key.snapshotKey, 'Demo/Win64/Development/UnrealEditor/x64');
    assert.ok(key.intermediateSegment.includes('Win64'));
  });

  it('maps obj.rsp /Tc to authoritative TU with flag parity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-parity-'));
    const { cppPath } = makeRspTree(root);
    const canonical = rspImporter.canonicalTuPath(cppPath, root);
    const actions = await rspImporter.importAuthoritativeActionsFromRsp(root, root);
    assert.ok(actions.length >= 1);
    const hit = actions.find((a) => a.file === canonical || a.file.toLowerCase() === canonical.toLowerCase());
    assert.ok(hit, 'expected TU from obj.rsp /Tc');
    assert.equal(hit.synthetic, false);
    assert.ok(hit.arguments.includes('-DPLATFORM=1'));
  });

  it('does not report ready when inputs changed (no stale false-fresh)', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-stale-'));
    makeRspTree(root);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]\n');
    const project = {
      name: 'ParityProj',
      projectRoot: root,
      uprojectPath: path.join(root, 'ParityProj.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    const snap = await buildSnapshot.buildCompileSnapshot({ project });
    await buildSnapshot.saveBuildSnapshot(root, snap);
    assert.equal(await buildSnapshot.snapshotFreshness(root), 'ready');

    fs.mkdirSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Two.uplugin'), '{}\n');
    fs.writeFileSync(path.join(root, 'Plugins', 'Two', 'Source', 'Two', 'Two.Build.cs'), 'class Two {}\n');
    assert.equal(await buildSnapshot.snapshotFreshness(root), 'stale');
  });

  it('marks a snapshot stale when the requested target/configuration changes', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-key-stale-'));
    makeRspTree(root);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]\n');
    const project = { name: 'ParityProj', projectRoot: root, uprojectPath: path.join(root, 'ParityProj.uproject'), engineAssociation: '5.8', modules: [] };
    const snap = await buildSnapshot.buildCompileSnapshot({ project, targetType: 'Editor', configuration: 'Development' });
    await buildSnapshot.saveBuildSnapshot(root, snap);
    assert.equal(await buildSnapshot.snapshotFreshness(root, undefined, undefined, { project, targetType: 'Editor', configuration: 'Development' }), 'ready');
    assert.equal(await buildSnapshot.snapshotFreshness(root, undefined, undefined, { project, targetType: 'Game', configuration: 'Shipping' }), 'stale');
  });

  it('detects RSP rename as stale even when its contents are unchanged', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-rsp-rename-'));
    const { shared } = makeRspTree(root);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]\n');
    const project = { name: 'ParityProj', projectRoot: root, uprojectPath: path.join(root, 'ParityProj.uproject'), engineAssociation: '5.8', modules: [] };
    const snap = await buildSnapshot.buildCompileSnapshot({ project });
    await buildSnapshot.saveBuildSnapshot(root, snap);
    fs.renameSync(shared, shared.replace('.Shared.rsp', '.Renamed.Shared.rsp'));
    assert.equal(await buildSnapshot.snapshotFreshness(root), 'stale');
  });

  it('detects a newly added Target.cs input as stale', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-target-input-'));
    makeRspTree(root);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]\n');
    const project = { name: 'ParityProj', projectRoot: root, uprojectPath: path.join(root, 'ParityProj.uproject'), engineAssociation: '5.8', modules: [] };
    const snap = await buildSnapshot.buildCompileSnapshot({ project });
    fs.writeFileSync(path.join(root, 'Source', 'ParityProj.Target.cs'), 'public class ParityProjTarget {}\n');
    assert.equal(await buildSnapshot.inputsStillValid(snap), false);
  });

  it('tracks engine-level BuildConfiguration and separate UBT/toolchain identity', async () => {
    const buildSnapshot = loadBuildSnapshot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-engine-input-'));
    makeRspTree(root);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]\n');
    const engineRoot = path.join(root, 'UE');
    const configPath = path.join(engineRoot, 'Engine', 'Saved', 'UnrealBuildTool', 'BuildConfiguration.xml');
    const ubtPath = path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'RunUBT.bat');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(ubtPath), { recursive: true });
    fs.writeFileSync(configPath, '<Configuration>one</Configuration>\n');
    fs.writeFileSync(ubtPath, '@echo off\n');
    fs.writeFileSync(path.join(engineRoot, 'Engine', 'Build', 'Build.version'), '{"BuildId":"test"}\n');
    const project = { name: 'ParityProj', projectRoot: root, uprojectPath: path.join(root, 'ParityProj.uproject'), engineAssociation: '5.8', modules: [] };
    const engine = { root: engineRoot, ubtPath, editorPath: '', version: '5.8', source: 'manual', isSourceBuild: false };
    const snap = await buildSnapshot.buildCompileSnapshot({ project, engine });
    assert.ok(snap.ubtVersion?.startsWith('ubt:'));
    assert.ok(snap.inputs.some((input) => input.path === configPath));
    fs.writeFileSync(configPath, '<Configuration>two</Configuration>\n');
    assert.equal(await buildSnapshot.inputsStillValid(snap, engine), false);
  });

  it('handles Unicode paths in canonicalTuPath', () => {
    const root = 'C:/프로젝트/게임';
    const file = path.join(root, 'Source', '모듈', '한글.cpp');
    const canon = rspImporter.canonicalTuPath(file, root);
    assert.ok(canon.includes('한글.cpp'));
  });

  it('links authoritative TUs and semantic flags at 100% across a multi-file module', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-tu-link-'));
    const { rspDir, shared } = makeRspTree(root, { projectName: 'Many' });
    for (let i = 0; i < 20; i++) {
      const source = path.join(root, 'Source', 'Many', 'Private', `Part${i}.cpp`);
      fs.writeFileSync(source, `int Part${i};\n`);
      fs.writeFileSync(
        path.join(rspDir, `Module.Many${i}.cpp.obj.rsp`),
        [`@"${shared.replace(/\\/g, '/')}"`, `/Tc"${source.replace(/\\/g, '/')}"`, `/FI"${path.join(rspDir, 'Definitions.Many.h').replace(/\\/g, '/')}"`].join('\n') + '\n',
      );
    }
    const authoritative = await rspImporter.importAuthoritativeActionsFromRsp(root, root);
    const ide = authoritative.map((action) => ({
      ...action,
      // compile_commands entries carry the compiler, source file, and compile
      // mode; those must not affect semantic flag parity.
      arguments: ['clang++.exe', ...action.arguments, '-c', action.file],
    }));
    const flags = projectModel.compareActionHashes(authoritative, ide, { mode: 'flags' });
    const tus = projectModel.compareActionHashes(authoritative, ide, { mode: 'tu' });
    assert.equal(authoritative.length, 21);
    assert.ok(flags.parity >= 0.95, `flag parity ${flags.parity}`);
    assert.ok(tus.tuRate >= 0.95, `TU linkage ${tus.tuRate}`);
  });

  it('collects 10k rsp files within perf budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-rsp-perf-'));
    const base = path.join(root, 'Intermediate', 'Build', 'Win64', 'x64', 'UnrealEditor', 'Development', 'Perf');
    fs.mkdirSync(base, { recursive: true });
    for (let i = 0; i < 10_000; i++) {
      fs.writeFileSync(path.join(base, `M${i}.Shared.rsp`), '/DIDX=' + i + '\n');
    }
    const start = Date.now();
    const paths = await rspImporter.collectRspPaths(root);
    const elapsed = Date.now() - start;
    assert.equal(paths.length, 10_000);
    assert.ok(elapsed < 10_000, `collectRspPaths took ${elapsed}ms`);
  });
});
