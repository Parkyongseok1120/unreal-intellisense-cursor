import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const security = loadTsModule('src/mcp/commandBridgeSecurity.ts');

describe('commandBridgeSecurity', () => {
  it('rejects oversized body', () => {
    const result = security.validateCommandBridgeRequest('x'.repeat(5000));
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
  });

  it('rejects missing command', () => {
    const result = security.validateCommandBridgeRequest('{}');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('rejects non-allowlisted command', () => {
    const result = security.validateCommandBridgeRequest(
      JSON.stringify({ command: 'vscode.openFolder', args: [] }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });

  it('accepts allowlisted command', () => {
    const result = security.validateCommandBridgeRequest(
      JSON.stringify({ command: 'ue58rider.build', args: [], issuedAt: Date.now() }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.request.command, 'ue58rider.build');
  });

  it('rejects expired request', () => {
    const result = security.validateCommandBridgeRequest(
      JSON.stringify({ command: 'ue58rider.build', issuedAt: Date.now() - 120_000 }),
      { now: Date.now(), maxAgeMs: 60_000 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it('extracts bearer token', () => {
    assert.equal(security.extractBearerToken('Bearer abc123'), 'abc123');
    assert.equal(security.extractBearerToken(undefined), undefined);
  });
});
