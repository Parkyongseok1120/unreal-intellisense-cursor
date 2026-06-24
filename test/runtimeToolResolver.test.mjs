import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const LOGICAL_KEYWORDS = {
  openAsset: [['open'], ['asset']],
  getAssetReferencers: [['referencer', 'reference'], ['asset']],
  liveCodingCompile: [['live'], ['coding', 'compile']],
};

function scoreToolName(name, keywords) {
  const lower = name.toLowerCase();
  let score = 0;
  for (const group of keywords) {
    if (group.some((k) => lower.includes(k))) score += 10;
  }
  return score;
}

function parseToolsetTools(describeText) {
  try {
    const json = JSON.parse(describeText);
    if (json.tools) return json.tools;
  } catch {
    // fall through
  }
  return [];
}

function resolveToolFromCatalog(logical, toolsetName, tools) {
  const keywords = LOGICAL_KEYWORDS[logical];
  let best;
  for (const tool of tools) {
    const text = `${tool.name} ${tool.description ?? ''}`;
    const score = scoreToolName(text, keywords);
    if (!best || score > best.score) best = { name: tool.name, score };
  }
  if (!best || best.score < 10) return undefined;
  return { toolset: toolsetName, tool: best.name };
}

describe('runtimeToolResolver', () => {
  it('parses describe_toolset JSON', () => {
    const tools = parseToolsetTools(
      JSON.stringify({
        tools: [
          { name: 'open_asset', description: 'Open asset in editor' },
          { name: 'list_assets' },
        ],
      }),
    );
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'open_asset');
  });

  it('resolves openAsset to open_asset in AssetTools', () => {
    const tools = [
      { name: 'open_asset', description: 'Open an asset' },
      { name: 'list_assets' },
    ];
    const resolved = resolveToolFromCatalog('openAsset', 'AssetTools', tools);
    assert.ok(resolved);
    assert.equal(resolved.tool, 'open_asset');
    assert.equal(resolved.toolset, 'AssetTools');
  });

  it('resolves liveCodingCompile', () => {
    const tools = [{ name: 'CompileLiveCoding', description: 'Compile live coding' }];
    const resolved = resolveToolFromCatalog('liveCodingCompile', 'LiveCodingToolset', tools);
    assert.ok(resolved);
    assert.equal(resolved.tool, 'CompileLiveCoding');
  });
});
