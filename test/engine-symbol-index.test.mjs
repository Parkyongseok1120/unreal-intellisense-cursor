import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('engine and plugin symbol index', () => {
  it('appendEngineBaseSymbols adds missing engine classes when headers exist', () => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-engine-'));
    const actorHeader = path.join(engineRoot, 'Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h');
    fs.mkdirSync(path.dirname(actorHeader), { recursive: true });
    fs.writeFileSync(actorHeader, '#pragma once\nclass AActor;\n');

    const symbols = projectModel.appendEngineBaseSymbols([], engineRoot);
    const actor = symbols.find((s) => s.name === 'AActor');
    assert.ok(actor, 'AActor symbol should be indexed');
    assert.equal(actor.sourceFile, actorHeader);
    assert.equal(actor.confidence, 'derived');
    assert.equal(actor.provenance, 'source-parser');

    fs.rmSync(engineRoot, { recursive: true, force: true });
  });

  it('appendEngineBaseSymbols skips classes already present in project symbols', () => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-engine-'));
    const actorHeader = path.join(engineRoot, 'Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h');
    fs.mkdirSync(path.dirname(actorHeader), { recursive: true });
    fs.writeFileSync(actorHeader, '#pragma once\n');

    const existing = [{
      id: 'Game@AMyActor@c:/project/myactor.h',
      name: 'AActor',
      sourceFile: 'C:/Project/Source/Game/Public/MyActor.h',
      sourceLine: 1,
      provenance: 'uht',
      confidence: 'authoritative',
    }];
    const symbols = projectModel.appendEngineBaseSymbols(existing, engineRoot);
    assert.equal(symbols.length, 1, 'should not duplicate AActor');

    fs.rmSync(engineRoot, { recursive: true, force: true });
  });

  it('appendPluginNavigableSymbols adds plugin reflection classes', () => {
    const pluginRoot = 'C:/Project/Plugins/MyPlugin/Source/MyPlugin/Public/MyActor.h';
    const modules = [{
      name: 'MyPlugin',
      root: 'C:/Project/Plugins/MyPlugin/Source/MyPlugin',
      publicHeaders: [],
      translationUnits: [],
    }];
    const plugins = [{ name: 'MyPlugin', modules: ['MyPlugin'] }];
    const reflection = [{
      className: 'AMyPluginActor',
      filePath: pluginRoot,
      classLine: 8,
      declarationRange: symbolModel.declarationRangeFromClassLine(8, 'AMyPluginActor'),
      properties: [],
      functions: [],
    }];

    const symbols = projectModel.appendPluginNavigableSymbols([], modules, plugins, reflection);
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, 'AMyPluginActor');
    assert.equal(symbols[0].moduleName, 'MyPlugin');
    assert.equal(symbols[0].confidence, 'derived');
  });
});
