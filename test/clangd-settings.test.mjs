import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const clangdConfig = loadTsModule('src/cursor/clangdConfig.ts', {
  '../platform/workspaceMutation': () => ({ mutateText: async () => {} }),
});
const workspaceSetup = loadTsModule('src/cursor/workspaceSetup.ts', {
  './explorerFilter': () => ({ getExplorerFilterSettings: () => ({}), getFilesExclude: () => ({}), getSearchExclude: () => ({}), getWatcherExclude: () => ({}), isExplorerFilterApplied: () => false, stripExplorerFilterMarkers: (x) => x }),
  './generatedArtifacts': () => ({ GENERATED_SETTINGS_FLAG: 'ue58rider.generated', GITIGNORE_MARKER: '# marker', GENERATED_GITIGNORE_LINES: [] }),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {}, mutateText: async () => {} }),
});
const multiRootWorkspace = loadTsModule('src/cursor/multiRootWorkspace.ts', {
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  './workspaceSetup': () => ({ buildUeSettings: workspaceSetup.buildUeSettings }),
});

describe('clangd settings scale safely for UE projects', () => {
  it('caps worker count by memory instead of using all CPU cores', () => {
    assert.equal(workspaceSetup.recommendedClangdJobs(8 * 1024 ** 3, 32), 2);
    assert.equal(workspaceSetup.recommendedClangdJobs(32 * 1024 ** 3, 32), 4);
    assert.equal(workspaceSetup.recommendedClangdJobs(128 * 1024 ** 3, 64), 6);
  });

  it('uses disk-backed PCH and leaves clang-tidy opt-in during indexing', () => {
    const settings = workspaceSetup.buildUeSettings({});
    const args = settings['clangd.arguments'];
    assert.ok(args.includes('--pch-storage=disk'));
    assert.ok(args.includes('--compile-commands-dir=${workspaceFolder}'));
    assert.ok(args.includes('--background-index-priority=low'));
    assert.equal(args.includes('--clang-tidy'), false);
  });

  it('does not inject every module include directory globally', () => {
    const block = clangdConfig.buildManagedClangdBlock({
      stubsPath: 'C:/P/.ue5_8cursor/UHTIDEStubs.h',
      intermediateIncludes: Array.from({ length: 200 }, (_, i) => `C:/P/Intermediate/Inc/M${i}`),
    });
    assert.ok(block.includes('UHTIDEStubs.h'));
    assert.ok(block.includes('-include-pch'), 'legacy invalid PCH flags must be stripped');
    assert.ok(block.includes('/Yu*'), 'MSVC PCH selection must not be passed to clangd');
    assert.match(block, /UnusedIncludes: None/);
    assert.match(block, /MissingIncludes: None/);
    assert.equal(block.includes('Intermediate/Inc/M199'), false);
    assert.ok(block.length < 1_000, `managed clangd block too large: ${block.length}`);
  });

  it('places clangd settings in the multi-root workspace scope', () => {
    const workspace = multiRootWorkspace.buildMultiRootWorkspaceContent(
      'Game',
      ['GameplayPlugin'],
      { clangdPath: 'C:/Extensions/ue/bin/clangd.exe', applyExplorerFilter: false },
    );
    assert.equal(workspace.settings['clangd.path'], 'C:/Extensions/ue/bin/clangd.exe');
    assert.ok(workspace.settings['clangd.arguments'].includes('--background-index'));
    assert.deepEqual(
      Array.from(workspace.folders, (folder) => folder.path),
      ['.', 'Source', 'Config', 'Plugins\\GameplayPlugin\\Source'],
    );
  });

  it('keeps workspace clangd configuration distinct from nested folder settings', () => {
    const workspace = multiRootWorkspace.buildMultiRootWorkspaceContent('Game', [], {
      clangdPath: 'C:/Extensions/ue/bin/clangd.exe',
      applyExplorerFilter: false,
    });
    assert.equal(workspace.settings['clangd.path'], 'C:/Extensions/ue/bin/clangd.exe');
    assert.equal(workspace.settings['C_Cpp.intelliSenseEngine'], 'disabled');
  });

  it('ships UE 5.8 generated-class compatibility stubs without inherited cast evaluation', () => {
    const stubs = fs.readFileSync('templates/UHTIDEStubs.h', 'utf8');
    assert.match(stubs, /#define DECLARE_CLASS2/);
    assert.match(stubs, /StaticAllClassCastFlags\(\) \\\n+\s*\{ \\\n+\s*return StaticClassCastFlags\(\);/);
    assert.match(stubs, /#define DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER/);
    assert.match(stubs, /return nullptr;/);
  });
});
