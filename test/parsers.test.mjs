import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline copy of parser logic for unit test (no VS Code deps)
const PROGRESS_PATTERNS = [/\[(\d+)\s*\/\s*(\d+)\]/, /(\d+)\s+of\s+(\d+)/i, /Building\s+(\d+)\s*\/\s*(\d+)/i];

function parseBuildProgress(line) {
  for (const pattern of PROGRESS_PATTERNS) {
    const m = line.match(pattern);
    if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  }
  return undefined;
}

describe('parseBuildProgress', () => {
  it('parses bracket progress', () => {
    const r = parseBuildProgress('Building [12/340] MyClass.cpp');
    assert.equal(r?.current, 12);
    assert.equal(r?.total, 340);
  });

  it('returns undefined for unrelated lines', () => {
    assert.equal(parseBuildProgress('Done.'), undefined);
  });
});

function normalizeUProject(data) {
  return {
    fileVersion: data.FileVersion ?? data.fileVersion ?? 3,
    engineAssociation: data.EngineAssociation ?? data.engineAssociation ?? '',
    modules: data.Modules ?? data.modules ?? [],
  };
}

describe('parseUProject casing', () => {
  it('accepts Unreal PascalCase keys', () => {
    const parsed = normalizeUProject({
      FileVersion: 3,
      EngineAssociation: '5.8',
      Modules: [{ Name: 'Project_MJS', Type: 'Runtime', LoadingPhase: 'Default' }],
    });

    assert.equal(parsed.fileVersion, 3);
    assert.equal(parsed.engineAssociation, '5.8');
    assert.equal(parsed.modules[0].Name, 'Project_MJS');
  });
});
