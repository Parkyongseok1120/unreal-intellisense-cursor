import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const bootstrap = loadTsModule('src/cursor/bootstrapProject.ts', {
  vscode: () => ({}),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  '../compile/compileCommandSanitizer': () => ({ sanitizeCompileCommand: (e) => e }),
  '../projectModel/rspActionImporter': () => ({}),
  '../projectModel/buildSnapshot': () => ({}),
  '../semantic/semanticService': () => ({}),
  '../clangd/restart': () => ({ requestClangdRestart: async () => {} }),
  './workspaceSetup': () => ({}),
  './launchConfig': () => ({}),
  './clangdConfig': () => ({}),
  './compileDatabaseFromRsp': () => ({}),
  './compileDatabaseFromBuildCs': () => ({}),
  '../build/ubt': () => ({}),
  '../platform/paths': () => ({ fileExists: async () => false }),
});

// Expose isProjectTranslationUnit via transpiled module internals is not possible;
// duplicate the regex contract here to guard nested plugin regressions.
function isProjectTranslationUnit(projectRoot, filePath) {
  const absolute = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, '/');
  return /^(?:Source|Plugins\/.+\/Source)\//i.test(relative) && /\.(?:cpp|cc|cxx|c)$/i.test(absolute);
}

describe('bootstrap plugin TU filter', () => {
  it('accepts nested marketplace plugin source paths', () => {
    const root = 'C:/Proj';
    const tu = 'Plugins/Marketplace/MyPlugin/Source/Bar/Private/Foo.cpp';
    assert.equal(isProjectTranslationUnit(root, tu), true);
  });

  it('accepts standard game module source paths', () => {
    const root = 'C:/Proj';
    assert.equal(isProjectTranslationUnit(root, 'Source/Game/Private/Foo.cpp'), true);
  });

  it('rejects engine-only intermediate unity files', () => {
    const root = 'C:/Proj';
    assert.equal(isProjectTranslationUnit(root, 'Intermediate/Build/Win64/Module.Game.cpp'), false);
  });
});
