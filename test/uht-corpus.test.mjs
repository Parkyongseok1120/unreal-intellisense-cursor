import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const uhtRunner = loadTsModule('src/uht/uhtRunner.ts');
const ueInspections = loadTsModule('src/uht/ueInspections.ts', {
  vscode: () => ({
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Range: class {
      constructor(a, b, c, d) {
        this.start = a;
        this.end = c;
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
      }
    },
  }),
});

const corpusPath = path.join(process.cwd(), 'test', 'fixtures', 'uht-corpus', 'cases.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));

describe('uht corpus', () => {
  for (const c of corpus.authoritativeCases) {
    it(`parses authoritative: ${c.id}`, () => {
      const diags = uhtRunner.parseUhtOutput(c.output);
      const match = diags.find(
        (d) => path.normalize(d.file).toLowerCase() === path.normalize(c.expectedFile).toLowerCase(),
      );
      assert.ok(match, `expected diagnostic for ${c.expectedFile}`);
      assert.equal(match.line, c.expectedLine);
      assert.equal(match.severity, c.severity);
    });
  }

  for (const c of corpus.inspectionCases) {
    it(`inspection: ${c.id}`, () => {
      const result = ueInspections.runUeInspections(c.header, true);
      const errors = result.inspections.filter((i) => i.severity === 'error').length;
      const warnings = result.inspections.filter((i) => i.severity === 'warning').length;
      if (c.expectErrors !== undefined) assert.equal(errors, c.expectErrors, `errors in ${c.id}`);
      if (c.expectWarnings !== undefined) assert.equal(warnings, c.expectWarnings, `warnings in ${c.id}`);
      if (c.ruleId) assert.ok(result.inspections.some((i) => i.id === c.ruleId), c.ruleId);
    });
  }

  it('meets minimum corpus size', () => {
    assert.ok(corpus.authoritativeCases.length + corpus.inspectionCases.length >= 6);
  });
});
