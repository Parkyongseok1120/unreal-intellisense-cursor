import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const invalidation = loadTsModule('src/detection/invalidation.ts');

describe('sourceWatcher invalidation', () => {
  const root = 'C:/Project';

  it('classifies new cpp as translation unit', () => {
    const event = invalidation.classifySourceChange(`${root}/Source/Game/Private/Foo.cpp`, true, root);
    assert.equal(event.scope, 'translationUnit');
    assert.equal(invalidation.shouldRefreshCompileDatabase(event), true);
  });

  it('classifies new header as reflection without full compile refresh on change-only path', () => {
    const event = invalidation.classifySourceChange(`${root}/Source/Game/Public/Foo.h`, false, root);
    assert.equal(event.scope, 'reflection');
    assert.equal(invalidation.shouldRefreshReflectionOnly(event), true);
  });

  it('classifies Build.cs as module invalidate', () => {
    const event = invalidation.classifySourceChange(`${root}/Source/Game/Game.Build.cs`, false, root);
    assert.equal(event.scope, 'module');
  });

  it('classifies uproject as project model invalidate', () => {
    const event = invalidation.classifySourceChange(`${root}/Game.uproject`, false, root);
    assert.equal(event.scope, 'projectModel');
  });
});
