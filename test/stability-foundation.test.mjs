import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const invalidation = loadTsModule('src/detection/invalidation.ts');
const fingerprint = loadTsModule('src/cursor/headerCompileContextFingerprint.ts');

describe('stability foundation', () => {
  const root = 'C:/Project';

  it('classifies cpp change as reflection-only (no compile DB refresh)', () => {
    const event = invalidation.classifySourceChange(`${root}/Source/Game/Private/Foo.cpp`, false, root);
    assert.equal(event.scope, 'reflection');
    assert.equal(invalidation.shouldRefreshCompileDatabase(event), false);
    assert.equal(invalidation.shouldRefreshReflectionOnly(event), true);
  });

  it('fingerprint changes when compilation command args change', () => {
    const base = {
      headerPath: `${root}/Source/Game/Public/Foo.h`,
      provenance: 'authoritative-module-tu',
      translationUnit: `${root}/Source/Game/Private/Foo.cpp`,
      compilationCommand: ['clang++', '-I', 'A'],
      reason: 'test',
    };
    const other = { ...base, compilationCommand: ['clang++', '-I', 'B'] };
    assert.notEqual(
      fingerprint.buildHeaderContextFingerprint(base),
      fingerprint.buildHeaderContextFingerprint(other),
    );
  });
});
