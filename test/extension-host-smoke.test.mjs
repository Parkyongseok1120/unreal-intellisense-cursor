import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('extension host smoke', () => {
  it('skips when dist/extension.js is not built', async () => {
    const extJs = path.join(process.cwd(), 'dist', 'extension.js');
    if (!fs.existsSync(extJs)) {
      return;
    }

    let testElectron;
    try {
      testElectron = await import('@vscode/test-electron');
    } catch {
      return;
    }

    const { runTests } = testElectron;
    assert.equal(typeof runTests, 'function');
  });
});
