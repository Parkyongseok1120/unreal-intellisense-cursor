import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const uht = loadTsModule('src/uht/uhtRunner.ts', {
  '../platform/process': () => ({
    spawnAsync: async () => ({ exitCode: 1, stdout: '', stderr: 'manifest missing' }),
  }),
});

describe('uhtRunner', () => {
  it('parses UHT diagnostic lines', () => {
    const output = 'C:/Project/Source/Game/Public/MyActor.h(12): error C1234: GENERATED_BODY required';
    const diags = uht.parseUhtOutput(output);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].line, 12);
    assert.equal(diags[0].severity, 'error');
    assert.match(diags[0].message, /GENERATED_BODY/);
  });

  it('suggests RPC quick fixes', () => {
    const fixes = uht.suggestedQuickFixes({
      file: 'x.h',
      line: 1,
      column: 1,
      severity: 'error',
      message: 'RPC function missing _Implementation',
    });
    assert.ok(fixes.includes('Generate _Implementation stub'));
  });
});
