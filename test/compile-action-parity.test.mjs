import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../parsers/moduleLayout': () => ({
    discoverModuleLayouts: async () => [],
  }),
  '../platform/paths': () => ({
    fileExists: async () => false,
  }),
});

describe('compile action parity', () => {
  it('reports full parity for identical hashes', () => {
    const actions = [
      { file: 'C:/P/Source/Game/Private/A.cpp', arguments: ['clang++', '-I', 'x'], hash: 'abc' },
      { file: 'C:/P/Source/Game/Private/B.cpp', arguments: ['clang++', '-I', 'x'], hash: 'def' },
    ];
    const result = projectModel.compareActionHashes(actions, actions);
    assert.equal(result.matched, 2);
    assert.equal(result.parity, 1);
  });

  it('reports partial parity when hashes differ', () => {
    const expected = [{ file: 'C:/P/A.cpp', arguments: [], hash: '11111111' }];
    const actual = [{ file: 'C:/P/A.cpp', arguments: [], hash: '22222222' }];
    const result = projectModel.compareActionHashes(expected, actual);
    assert.equal(result.matched, 0);
    assert.equal(result.parity, 0);
  });
});
