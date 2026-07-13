import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const cppParser = loadTsModule('src/blueprint/cppClassParser.ts');
const symbolModel = loadTsModule('src/projectModel/symbolModel.ts');

const corpusPath = path.join(process.cwd(), 'test', 'fixtures', 'navigation-corpus', 'cases.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));

describe('navigation corpus', () => {
  for (const c of corpus.cases) {
    it(`class line: ${c.id}`, () => {
      const parsed = cppParser.parseUClassFromText(c.header).find((p) => p.className === c.className);
      assert.ok(parsed, `missing parsed class ${c.className}`);
      assert.equal(parsed.line, c.expectedClassLine, `${c.className} declaration line`);
      if (c.expectedParent) assert.equal(parsed.parentClass, c.expectedParent);
    });
  }

  it('enriches reflection with declaration range', () => {
    const c = corpus.cases[0];
    const reflection = {
      className: c.className,
      filePath: 'C:/Synthetic/MyActor.h',
      properties: [{ name: 'Health', line: 10 }],
      functions: [],
    };
    symbolModel.enrichReflectionFromHeaderContent(reflection, c.header, reflection.filePath);
    assert.equal(reflection.classLine, c.expectedClassLine);
    assert.ok(reflection.declarationRange);
    assert.equal(reflection.declarationRange.startLine, c.expectedClassLine);
    assert.notEqual(reflection.classLine, reflection.properties[0].line);
  });

  it('builds stable symbol IDs', () => {
    for (const c of corpus.symbolIdCases) {
      const id = symbolModel.buildStableSymbolId(c.module, c.className, c.sourceFile);
      assert.equal(id, c.expectedId);
    }
  });

  it('meets minimum corpus size', () => {
    assert.ok(corpus.cases.length >= 10);
  });
});
