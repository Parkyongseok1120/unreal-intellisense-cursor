import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const uhtDiagnostics = loadTsModule('src/uht/uhtDiagnostics.ts', {
  vscode: () => ({
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    languages: {
      createDiagnosticCollection: () => ({
        set: () => {},
        delete: () => {},
        clear: () => {},
        get: () => [],
        dispose: () => {},
      }),
    },
    Range: class {
      constructor(a, b, c, d) {
        this.start = { line: a, character: b };
        this.end = { line: c, character: d };
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
        this.source = '';
        this.code = undefined;
      }
    },
  }),
});

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const uhtRunner = loadTsModule('src/uht/uhtRunner.ts', {
  '../platform/process': () => ({ spawnAsync: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
});

describe('uht diagnostics', () => {
  it('converts UHT diagnostic to vscode shape', () => {
    const diag = uhtDiagnostics.uhtDiagnosticToVscode({
      file: 'C:/P/Foo.h',
      line: 10,
      column: 3,
      severity: 'error',
      message: 'missing GENERATED_BODY',
      code: 'UHT001',
    });
    assert.equal(diag.source, 'UHT');
    assert.equal(diag.message, 'missing GENERATED_BODY');
    assert.equal(diag.code, 'UHT001');
  });

  it('parses column from UHT output', () => {
    const output = 'C:/P/Foo.h(12,4): error UHT001: missing GENERATED_BODY()';
    const parsed = uhtRunner.parseUhtOutput(output);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].line, 12);
    assert.equal(parsed[0].column, 4);
  });

  it('suggests safe quick fixes only', () => {
    const fixes = uhtRunner.suggestedQuickFixes({
      file: 'C:/P/Foo.h',
      line: 1,
      column: 1,
      severity: 'error',
      message: 'missing GENERATED_BODY()',
    });
    assert.ok(fixes.some((f) => f.includes('GENERATED_BODY')));
    const implFixes = uhtRunner.suggestedQuickFixes({
      file: 'C:/P/Foo.h',
      line: 1,
      column: 1,
      severity: 'error',
      message: 'BlueprintNativeEvent must have _Implementation',
    });
    assert.equal(implFixes.length, 0);
  });
});
