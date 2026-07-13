import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const assetRefs = loadTsModule('src/assets/assetReferenceService.ts', {
  '../blueprint/mcpBlueprintBridge': () => ({
    mcpCallLogical: async () => {
      throw new Error('MCP should not be called when bridge is authoritative');
    },
  }),
  './assetPathParser': () => ({ findAssetPathsInDocument: async () => [] }),
  './assetIndex': () => ({ loadAssetIndex: async () => [] }),
});

describe('asset reference bridge authority', () => {
  it('returns empty referencers from connected bridge without MCP fallback', async () => {
    const bridge = {
      isConnected: () => true,
      getAssetReferencers: async () => [],
      getAssetDependencies: async () => [],
    };
    const refs = await assetRefs.getAssetReferencers('/Game/Foo.Bar', 2, bridge);
    assert.deepEqual(refs, []);
  });

  it('returns dependencies from connected bridge without MCP fallback', async () => {
    const bridge = {
      isConnected: () => true,
      getAssetReferencers: async () => [],
      getAssetDependencies: async () => [],
    };
    const deps = await assetRefs.getAssetDependencies('/Game/Foo.Bar', bridge);
    assert.deepEqual(deps, []);
  });
});
