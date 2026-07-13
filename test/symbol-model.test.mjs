import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const symbolModel = loadTsModule('src/projectModel/symbolModel.ts');
const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../uht/reflectionIndex': () => ({ buildReflectionIndex: async () => [] }),
  '../uht/uhtRunner': () => ({ findUhtManifest: async () => undefined, parseUhtManifestInputFiles: async () => [] }),
  '../platform/paths': () => ({ fileExists: async () => false }),
  '../platform/dataDir': () => ({ ensureDataDir: async (r) => r }),
  '../parsers/moduleLayout': () => ({ discoverModuleLayouts: async () => [] }),
  '../build/targetResolver': () => ({ discoverTargetsSync: () => [] }),
  './windowsCommandLine': () => ({ parseWindowsCommandLine: () => [], resolveCompilePath: (f) => f, canonicalCompilePath: (f) => f }),
  './rspActionImporter': () => ({ normalizeParityArgs: (a) => a }),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  './symbolModel': () => symbolModel,
});

describe('symbol model', () => {
  it('reflectionToSymbols uses classLine not first member line', () => {
    const reflection = [{
      className: 'AMyActor',
      filePath: 'C:/Project/Source/Game/Public/MyActor.h',
      classLine: 6,
      declarationRange: symbolModel.declarationRangeFromClassLine(6, 'AMyActor'),
      properties: [{ name: 'Health', line: 10 }],
      functions: [{ name: 'ResetState', line: 13 }],
    }];
    const symbols = projectModel.reflectionToSymbols(
      reflection,
      [],
      [{ name: 'Game', root: 'C:/Project/Source/Game', publicHeaders: [], translationUnits: [] }],
    );
    assert.equal(symbols[0].sourceLine, 6);
    assert.equal(symbols[0].classLine, 6);
    assert.notEqual(symbols[0].sourceLine, 10);
    assert.equal(symbols[0].id, 'Game@AMyActor@c:/project/source/game/public/myactor.h');
  });
});
