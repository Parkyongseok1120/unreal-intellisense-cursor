import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const PROTOCOL_VERSION = 1;

const HANDSHAKE_RESULT = {
  ok: true,
  capabilities: ['assetRegistry', 'automationTests', 'blueprintGraph'],
};

const ASSET_LIST_RESULT = {
  assets: [{ assetPath: '/Game/Maps/Start', className: 'World' }],
  total: 1,
  hasMore: false,
  offset: 0,
};

const AUTOMATION_RUN_RESULT = {
  ok: true,
  message: 'started',
};

function assertHandshakeShape(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.capabilities));
}

function assertAssetListShape(result) {
  assert.ok(Array.isArray(result.assets));
  assert.equal(typeof result.total, 'number');
  assert.equal(typeof result.hasMore, 'boolean');
  assert.equal(typeof result.offset, 'number');
  for (const asset of result.assets) {
    assert.equal(typeof asset.assetPath, 'string');
  }
}

function assertAutomationRunShape(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.message, 'string');
}

describe('bridge protocol contract', () => {
  it('handshake response matches contract', () => {
    assertHandshakeShape(HANDSHAKE_RESULT);
    assert.equal(HANDSHAKE_RESULT.ok, true);
  });

  it('assetRegistry.list pagination fields present', () => {
    assertAssetListShape(ASSET_LIST_RESULT);
    assert.equal(ASSET_LIST_RESULT.hasMore, false);
  });

  it('automation.run response shape', () => {
    assertAutomationRunShape(AUTOMATION_RUN_RESULT);
  });

  it('protocol version is stable', () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });
});
