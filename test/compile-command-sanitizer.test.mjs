import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const sanitizer = loadTsModule('src/projectModel/compileCommandSanitizer.ts');

describe('UBT compile command sanitizer', () => {
  it('expands recursive RSP and leaves exactly one source without build outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-cmd-'));
    const source = path.join(root, 'Source', 'Game', 'Private', 'Foo.cpp');
    const shared = path.join(root, 'Intermediate', 'Game.Shared.rsp');
    const object = path.join(root, 'Intermediate', 'Foo.cpp.obj.rsp');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(source, '// test');
    fs.writeFileSync(shared, '/DPROJECT_API=1\n/I "C:/Program Files/UE/Engine/Source"\n');
    fs.writeFileSync(object, [
      `"${source.replace(/\\/g, '/')}"`,
      `@"${shared.replace(/\\/g, '/')}"`,
      '/FI"Definitions.h"',
      '/Fo"Foo.cpp.obj"',
      '/clang:-MD',
      '/clang:-MF"Foo.cpp.d"',
      '/Yu"SharedPCH.h"',
    ].join('\n'));

    const result = sanitizer.sanitizeCompileCommand({
      directory: root,
      file: source,
      command: `clang-cl.exe @"${object.replace(/\\/g, '/')}"`,
      output: 'Foo.cpp.obj',
    });
    assert.ok(result);
    assert.equal(sanitizer.countSourceArguments(result), 1);
    assert.equal(result.arguments.some((arg) => /^\/(?:Fo|Yu)/i.test(arg)), false);
    assert.ok(result.arguments.includes('-DPROJECT_API=1') || result.arguments.includes('/DPROJECT_API=1'));
    assert.equal(result.arguments.some((arg) => arg.startsWith('@')), false);
    assert.equal('output' in result, false);
  });
});
