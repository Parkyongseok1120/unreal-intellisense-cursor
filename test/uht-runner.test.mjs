import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('suggests only safe header quick fixes', () => {
    const implFixes = uht.suggestedQuickFixes({ file: 'x.h', line: 1, column: 1, severity: 'error', message: 'RPC function missing _Implementation' });
    assert.equal(implFixes.length, 0);
    const bodyFixes = uht.suggestedQuickFixes({ file: 'x.h', line: 1, column: 1, severity: 'error', message: 'missing GENERATED_BODY()' });
    assert.ok(bodyFixes.some((f) => f.includes('GENERATED_BODY')));
  });

  it('finds a UHT manifest below the UE 5.8 x64 build layout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-uht-manifest-'));
    const manifest = path.join(root, 'Intermediate', 'Build', 'Win64', 'x64', 'DemoEditor', 'Development', 'DemoEditor.uhtmanifest');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{"Modules":[]}\n');
    const found = await uht.findUhtManifest({ name: 'Demo', projectRoot: root, uprojectPath: path.join(root, 'Demo.uproject'), engineAssociation: '5.8', modules: [] });
    assert.equal(found, manifest);
  });
});
