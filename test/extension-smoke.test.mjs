import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const version = loadTsModule('src/version.ts');

describe('extension smoke', () => {
  it('package.json exposes extension entry and commands', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    assert.equal(pkg.main, './dist/extension.js');
    assert.ok(Array.isArray(pkg.contributes?.commands));
    assert.ok(pkg.contributes.commands.length > 20);
  });

  it('version module reads package.json', () => {
    const v = version.getExtensionVersion(process.cwd());
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });

  it('synthetic UE fixture exists', () => {
    const uproject = path.join(process.cwd(), 'test', 'fixtures', 'synthetic-ue-project', 'Synthetic.uproject');
    assert.ok(fs.existsSync(uproject));
    const parsed = JSON.parse(fs.readFileSync(uproject, 'utf-8'));
    assert.equal(parsed.EngineAssociation, '5.8');
    assert.ok(parsed.Modules.length >= 2);
  });
});
