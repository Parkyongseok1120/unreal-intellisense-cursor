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
    assert.ok(corpus.cases.length >= 50);
    assert.ok((corpus.referenceCases?.length ?? 0) >= 10);
  });

  it('links UINTERFACE U-class to I-class companion', () => {
    const c = corpus.cases.find((entry) => entry.id === 'uinterface-pair');
    assert.ok(c);
    const parsed = cppParser.parseUClassFromText(c.header).find((p) => p.className === c.className);
    assert.ok(parsed?.isInterface);
    assert.equal(parsed?.interfaceCompanion, 'IMyInteractable');
    assert.ok(parsed?.interfaceCompanionLine !== undefined);
  });

  it('validates hierarchyCases parent/child lines', () => {
    const classByName = new Map();
    for (const c of corpus.cases) {
      for (const parsed of cppParser.parseUClassFromText(c.header)) {
        classByName.set(parsed.className, parsed);
      }
    }
    for (const h of corpus.hierarchyCases ?? []) {
      const child = classByName.get(h.child);
      const parent = classByName.get(h.parent);
      assert.ok(child, `missing child ${h.child}`);
      assert.ok(parent, `missing parent ${h.parent}`);
      assert.equal(child.parentClass, h.parent, h.id);
      assert.equal(child.line, h.childLine, h.id);
      assert.equal(parent.line, h.parentLine, h.id);
    }
  });

  it('validates referenceCases symbol occurrences', () => {
    const refNav = loadTsModule('src/navigation/referenceNavigation.ts', {
      vscode: () => ({
        Uri: { file: (p) => ({ fsPath: p }) },
        Range: class Range {
          constructor(a, b, c, d) {
            this.start = { line: a, character: b };
            this.end = { line: c, character: d };
          }
        },
        Location: class Location {
          constructor(uri, range) {
            this.uri = uri;
            this.range = range;
          }
        },
      }),
      '../parsers/moduleLayout': () => ({
        findPairedSourceFile: (file) => (file.endsWith('.h') ? file.replace(/\.h$/i, '.cpp') : undefined),
      }),
      './symbolNavigation': () => ({
        findEnclosingUeClass: () => undefined,
      }),
    });

    for (const c of corpus.referenceCases ?? []) {
      const headerPath = path.join(process.cwd(), 'test', 'fixtures', 'navigation-corpus', `${c.id}.h`);
      const cppPath = path.join(process.cwd(), 'test', 'fixtures', 'navigation-corpus', `${c.id}.cpp`);
      fs.mkdirSync(path.dirname(headerPath), { recursive: true });
      fs.writeFileSync(headerPath, c.header);
      if (c.cpp) fs.writeFileSync(cppPath, c.cpp);

      const lines = c.header.split(/\r?\n/);
      let symbolLine = 0;
      let symbolCol = 0;
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf(c.symbol);
        if (idx >= 0) {
          symbolLine = i;
          symbolCol = idx;
          break;
        }
      }

      const document = {
        fileName: headerPath,
        lineAt: (line) => ({ text: lines[line] ?? '' }),
        getText: (range) => lines[range.start.line]?.slice(range.start.character, range.end.character) ?? '',
        getWordRangeAtPosition: (pos, re) => {
          const text = lines[pos.line] ?? '';
          const match = text.match(re);
          if (!match) return undefined;
          const start = text.indexOf(match[0]);
          return { start: { line: pos.line, character: start }, end: { line: pos.line, character: start + match[0].length } };
        },
      };

      const refs = refNav.findUeReferences(document, { line: symbolLine, character: symbolCol }, { moduleScan: false });
      assert.ok(refs.length >= (c.expectedLocations ?? 1), `${c.id}: expected >= ${c.expectedLocations}, got ${refs.length}`);
    }
  });
});
