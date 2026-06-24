import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fallbackPath = path.join(__dirname, '..', 'schemas', 'ue58-mcp-fallback.json');
const capturedPath = path.join(__dirname, '..', 'schemas', 'ue58-mcp-captured.json');

describe('ue58-mcp-fallback schema', () => {
  it('loads and has required meta tools', () => {
    const schema = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    assert.equal(schema.engineMcpMode, 'tool-search');
    assert.equal(schema.defaultPort, 8000);
    assert.equal(schema.metaTools.callTool, 'call_tool');
    assert.equal(schema.metaTools.listToolsets, 'list_toolsets');
  });

  it('defines logical tool candidates for openAsset', () => {
    const schema = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    const open = schema.logicalTools.openAsset;
    assert.ok(open.candidates.length >= 1);
    const epic = open.candidates.find((c) => c.toolset === 'AssetTools');
    assert.ok(epic);
    assert.equal(epic.tool, 'open_asset');
  });

  it('requires MCP plugins', () => {
    const schema = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    assert.ok(schema.requiredPlugins.includes('ModelContextProtocol'));
    assert.ok(schema.requiredPlugins.includes('AllToolsets'));
  });
});

describe('ue58-mcp-captured schema', () => {
  it('loads captured fixture', () => {
    const schema = JSON.parse(fs.readFileSync(capturedPath, 'utf-8'));
    assert.ok(schema.capturedAt);
    assert.equal(schema.defaultPort, 8000);
    assert.ok(schema.toolsets.AssetTools);
  });

  it('captured logical tool keys match fallback', () => {
    const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf-8'));
    const fallbackKeys = Object.keys(fallback.logicalTools).sort();
    const capturedKeys = Object.keys(captured.logicalTools).sort();
    assert.deepEqual(capturedKeys, fallbackKeys);
  });

  it('validates schema JSON structure', () => {
    const schema = JSON.parse(fs.readFileSync(capturedPath, 'utf-8'));
    assert.equal(typeof schema.version, 'string');
    assert.equal(typeof schema.metaTools.callTool, 'string');
    for (const [name, def] of Object.entries(schema.logicalTools)) {
      assert.ok(def.candidates?.length >= 1, `${name} has candidates`);
    }
  });

  it('captured AssetTools includes core tool names', () => {
    const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf-8'));
    const tools = captured.toolsets?.AssetTools?.tools ?? [];
    for (const required of ['open_asset', 'get_asset_info', 'get_referencers']) {
      assert.ok(tools.includes(required), `missing ${required}`);
    }
  });
});

function mapArgs(logicalArgs, argMap) {
  if (!argMap || Object.keys(argMap).length === 0) return { ...logicalArgs };
  const mapped = {};
  for (const [logical, value] of Object.entries(logicalArgs)) {
    mapped[argMap[logical] ?? logical] = value;
  }
  return mapped;
}

describe('MCP arg mapping', () => {
  it('maps path to asset_path for Epic AssetTools', () => {
    const mapped = mapArgs({ path: '/Game/Foo.Bar' }, { path: 'asset_path' });
    assert.equal(mapped.asset_path, '/Game/Foo.Bar');
    assert.equal(mapped.path, undefined);
  });
});
