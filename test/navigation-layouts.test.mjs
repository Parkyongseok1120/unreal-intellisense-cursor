import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const moduleLayout = loadTsModule('src/parsers/moduleLayout.ts', {
  '../platform/paths': () => ({
    fileExists: async (p) => fs.existsSync(p),
  }),
});

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('cross-project file pairing', () => {
  it('pairs mirrored Public/Private relative paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-layout-mirror-'));
    touch(path.join(root, 'Source', 'Game', 'Public', 'Enemy', 'Foo.h'), 'class AFoo {};');
    touch(path.join(root, 'Source', 'Game', 'Private', 'Enemy', 'Foo.cpp'), '#include "Foo.h"');
    const header = path.join(root, 'Source', 'Game', 'Public', 'Enemy', 'Foo.h');
    const source = path.join(root, 'Source', 'Game', 'Private', 'Enemy', 'Foo.cpp');
    assert.equal(moduleLayout.findPairedSourceFile(header), path.normalize(source));
    assert.equal(moduleLayout.findPairedSourceFile(source), path.normalize(header));
  });

  it('pairs asymmetric Public/Sub/Foo.h with Private/Foo.cpp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-layout-asym-'));
    touch(path.join(root, 'Source', 'Game', 'Public', 'Characters', 'Foo.h'));
    touch(path.join(root, 'Source', 'Game', 'Private', 'Foo.cpp'));
    const header = path.join(root, 'Source', 'Game', 'Public', 'Characters', 'Foo.h');
    const source = path.join(root, 'Source', 'Game', 'Private', 'Foo.cpp');
    assert.equal(moduleLayout.findPairedSourceFile(header), path.normalize(source));
  });

  it('pairs co-located flat module files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-layout-flat-'));
    touch(path.join(root, 'Source', 'LegacyMod', 'Foo.h'));
    touch(path.join(root, 'Source', 'LegacyMod', 'Foo.cpp'));
    const header = path.join(root, 'Source', 'LegacyMod', 'Foo.h');
    const source = path.join(root, 'Source', 'LegacyMod', 'Foo.cpp');
    assert.equal(moduleLayout.findPairedSourceFile(header), path.normalize(source));
  });

  it('normalizes .generated.h basename for pairing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-layout-gen-'));
    touch(path.join(root, 'Source', 'Game', 'Public', 'Foo.h'));
    touch(path.join(root, 'Source', 'Game', 'Private', 'Foo.cpp'));
    const generated = path.join(root, 'Source', 'Game', 'Private', 'Foo.generated.h');
    touch(generated);
    assert.equal(moduleLayout.normalizePairingBaseName(generated), 'Foo');
    assert.equal(
      moduleLayout.findPairedSourceFile(generated),
      path.normalize(path.join(root, 'Source', 'Game', 'Public', 'Foo.h')),
    );
  });

  it('finds nested plugin module roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-layout-plugin-'));
    touch(path.join(root, 'Plugins', 'Marketplace', 'MyPlugin', 'Source', 'Bar', 'Public', 'X.h'));
    const moduleRoot = moduleLayout.findModuleRootSync(root, 'Bar');
    assert.equal(
      moduleRoot,
      path.normalize(path.join(root, 'Plugins', 'Marketplace', 'MyPlugin', 'Source', 'Bar')),
    );
  });
});
