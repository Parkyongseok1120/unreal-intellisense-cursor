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

  it('classifies new header as uhtModule with compile refresh', () => {
    const event = invalidation.classifySourceChange(`${root}/Source/Game/Public/Foo.h`, true, root);
    assert.equal(event.scope, 'uhtModule');
    assert.equal(invalidation.shouldRefreshCompileDatabase(event), true);
    assert.equal(invalidation.shouldRefreshReflectionOnly(event), false);
  });

  it('classifies header change as reflection-only path', () => {
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

describe('sourceWatcher batch pending sets', () => {
  const root = 'C:/Project';

  it('accumulates three cpp creates as translation units', () => {
    const pending = {
      translationUnits: new Set(),
      uhtModules: new Set(),
    };
    for (const file of ['A.cpp', 'B.cpp', 'C.cpp']) {
      const event = invalidation.classifySourceChange(`${root}/Source/Game/Private/${file}`, true, root);
      if (event.scope === 'translationUnit') pending.translationUnits.add(event.filePath);
    }
    assert.equal(pending.translationUnits.size, 3);
  });

  it('accumulates three header creates as uhtModule', () => {
    const pending = {
      translationUnits: new Set(),
      uhtModules: new Set(),
    };
    for (const file of ['A.h', 'B.h', 'C.h']) {
      const event = invalidation.classifySourceChange(`${root}/Source/Game/Public/${file}`, true, root);
      if (event.scope === 'uhtModule') pending.uhtModules.add(event.filePath);
      assert.equal(invalidation.shouldRefreshCompileDatabase(event), true);
    }
    assert.equal(pending.uhtModules.size, 3);
  });

  it('clears pending sets after batch flush simulation', () => {
    const pending = {
      translationUnits: new Set(['a.cpp', 'b.cpp', 'c.cpp']),
      uhtModules: new Set(['a.h']),
    };
    assert.equal(pending.translationUnits.size, 3);
    pending.translationUnits.clear();
    pending.uhtModules.clear();
    assert.equal(pending.translationUnits.size, 0);
    assert.equal(pending.uhtModules.size, 0);
  });
});
