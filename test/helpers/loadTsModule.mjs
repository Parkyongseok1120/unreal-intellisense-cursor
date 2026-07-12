import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, extraRequires = {}) {
  const ts = require('typescript');
  const sourcePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (id) => {
      if (extraRequires[id]) return extraRequires[id]();
      if (id === 'fs' || id === 'path' || id === 'crypto' || id === 'http') return require(id);
      return require(id);
    },
    __dirname: path.dirname(sourcePath),
    __filename: sourcePath,
    process,
    Buffer,
  };
  vm.runInNewContext(js, sandbox, { filename: sourcePath });
  return module.exports;
}

export { loadTsModule };
