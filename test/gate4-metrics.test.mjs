import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const metricsModule = loadTsModule('src/telemetry/intellisenseMetrics.ts', {
  '../constants': () => ({ EXTENSION_DATA_DIR: '.ue5_8cursor' }),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  '../platform/process': () => ({ spawnAsync: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }),
});
const headerContext = loadTsModule('src/projectModel/headerCompileContext.ts');

describe('Gate 4 IntelliSense metrics', () => {
  it('records peaks and labels cache-inactivity completion as a heuristic', async () => {
    let now = 0;
    const probe = {
      processes: async () => [{ pid: 10, workingSetBytes: 100, privateBytes: 80, matchedProject: true }],
      indexCache: async () => ({ files: 12, newestMtimeMs: 0 }),
    };
    const tracker = new metricsModule.IntelliSenseMetricsTracker('C:/Game', { probe, now: () => now });
    await tracker.start();
    tracker.markCompileDatabaseReady();
    tracker.markProjectModelReady({ projectTus: 4, pluginTus: 2 });
    now = 1_000;
    tracker.markProjectUsable(250);
    now = 21_000;
    await tracker.sample();
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.phase, 'fully-indexed');
    assert.equal(snapshot.cache.fullIndexHeuristic, true);
    assert.equal(snapshot.peak.privateBytes, 80);
    assert.deepEqual(Array.from(snapshot.timings.firstDefinitionMs ?? []), [250]);
    assert.equal(snapshot.acceptance.projectUsable, 'pass');
    assert.equal(snapshot.acceptance.privateMemory, 'pass');
    tracker.dispose();
  });

  it('marks a measured private-memory budget breach as a failure instead of claiming success', async () => {
    const probe = {
      processes: async () => [{
        pid: 10,
        workingSetBytes: 5 * 1024 ** 3,
        privateBytes: 5 * 1024 ** 3,
        matchedProject: true,
      }],
      indexCache: async () => ({ files: 0 }),
    };
    const tracker = new metricsModule.IntelliSenseMetricsTracker('C:/Game', { probe });
    await tracker.start();
    assert.equal(tracker.snapshot().acceptance.privateMemory, 'fail');
    tracker.dispose();
  });

  it('maps a header to an authoritative TU in its owning module only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-header-context-'));
    try {
      const header = path.join(root, 'Plugins', 'Foo', 'Source', 'Foo', 'Public', 'Feature.h');
      const sameStem = path.join(root, 'Plugins', 'Foo', 'Source', 'Foo', 'Private', 'Feature.cpp');
      const other = path.join(root, 'Source', 'Game', 'Private', 'Feature.cpp');
      fs.mkdirSync(path.dirname(header), { recursive: true });
      fs.mkdirSync(path.dirname(sameStem), { recursive: true });
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(header, '#pragma once\n');
      fs.writeFileSync(sameStem, 'void F() {}\n');
      fs.writeFileSync(other, 'void G() {}\n');
      fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([
        { directory: root, file: sameStem, arguments: ['clang++', sameStem] },
        { directory: root, file: other, arguments: ['clang++', other] },
      ]));
      const context = await headerContext.resolveHeaderCompileContext(root, header);
      assert.equal(context.provenance, 'authoritative-module-tu');
      assert.equal(path.normalize(context.translationUnit).toLowerCase(), path.normalize(sameStem).toLowerCase());
      assert.equal(path.normalize(context.compilationCommand.at(-1)).toLowerCase(), path.normalize(header).toLowerCase());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends only an authoritative header command through vscode-clangd without rebuilding the database', async () => {
    const sent = [];
    const headerBridge = loadTsModule('src/cursor/clangdHeaderContext.ts', {
      vscode: () => ({
        extensions: {
          getExtension: () => ({
            isActive: true,
            exports: { getApi: () => ({ languageClient: { sendNotification: async (...args) => sent.push(args) } }) },
          }),
        },
      }),
    });
    const result = await headerBridge.applyAuthoritativeHeaderCompileContext('C:/Game', {
      headerPath: 'C:/Game/Source/Game/Public/Foo.h',
      translationUnit: 'C:/Game/Source/Game/Private/Foo.cpp',
      workingDirectory: 'C:/Game',
      compilationCommand: ['clang++', '-I', 'C:/Game/Source/Game/Public', 'C:/Game/Source/Game/Public/Foo.h'],
      provenance: 'authoritative-module-tu',
      reason: 'Matched a same-stem authoritative translation unit.',
    });
    assert.equal(result.applied, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'workspace/didChangeConfiguration');
    assert.deepEqual(sent[0][1].settings.compilationDatabaseChanges['C:\\Game\\Source\\Game\\Public\\Foo.h'].compilationCommand.slice(-1), ['C:/Game/Source/Game/Public/Foo.h']);
  });
});
