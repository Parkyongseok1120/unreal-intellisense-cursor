import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('extension host smoke', () => {
  it('declares @vscode/test-electron and run-extension-host script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    assert.ok(pkg.devDependencies['@vscode/test-electron']);
    assert.equal(pkg.scripts['test:ext-host'], 'node test/run-extension-host.mjs');
    assert.ok(fs.existsSync(path.join(process.cwd(), 'test', 'run-extension-host.mjs')));
    assert.ok(fs.existsSync(path.join(process.cwd(), 'test', 'suite-extension', 'index.js')));
  });

  it('built extension bundle contains activate/deactivate', async () => {
    const extJs = path.join(process.cwd(), 'dist', 'extension.js');
    if (!fs.existsSync(extJs)) return;
    const text = fs.readFileSync(extJs, 'utf8');
    assert.match(text, /activate/);
    assert.match(text, /deactivate/);
  });
});
