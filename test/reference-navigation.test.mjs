import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const refs = loadTsModule('src/navigation/referenceNavigation.ts', {
  vscode: () => ({
    Uri: { file: (p) => ({ fsPath: p }) },
    Location: class {
      constructor(uri, range) {
        this.uri = uri;
        this.range = range;
      }
    },
    Range: class {
      constructor(startLine, startCol, endLine, endCol) {
        this.start = { line: startLine, character: startCol };
        this.end = { line: endLine, character: endCol };
      }
    },
  }),
  '../parsers/moduleLayout': () => ({
    findPairedSourceFile: (file) => {
      if (file.endsWith('.h')) return file.replace(`${path.sep}Public${path.sep}`, `${path.sep}Private${path.sep}`).replace('.h', '.cpp');
      return file.replace(`${path.sep}Private${path.sep}`, `${path.sep}Public${path.sep}`).replace('.cpp', '.h');
    },
  }),
  './symbolNavigation': () => ({
    findEnclosingUeClass: () => 'AFoo',
  }),
});

describe('reference navigation', () => {
  it('finds references in paired header and cpp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-refs-'));
    const header = path.join(root, 'Source', 'Game', 'Public', 'Foo.h');
    const cpp = path.join(root, 'Source', 'Game', 'Private', 'Foo.cpp');
    fs.mkdirSync(path.dirname(header), { recursive: true });
    fs.mkdirSync(path.dirname(cpp), { recursive: true });
    fs.writeFileSync(header, 'class AFoo { void Bar(); };\n', 'utf-8');
    fs.writeFileSync(cpp, 'void AFoo::Bar() { Helper(); }\n', 'utf-8');

    const headerText = fs.readFileSync(header, 'utf-8');
    const barIndex = headerText.indexOf('Bar');
    const document = {
      fileName: header,
      getText: (range) => (range ? 'Bar' : headerText),
      getWordRangeAtPosition: () => ({
        start: { line: 0, character: barIndex },
        end: { line: 0, character: barIndex + 3 },
      }),
      lineAt: (line) => ({ text: headerText.split('\n')[line] }),
    };

    const locations = refs.findUeReferences(document, { line: 0, character: barIndex }, { projectRoot: root, moduleScan: false });
    const files = new Set(locations.map((loc) => path.basename(loc.uri.fsPath)));
    assert.ok(files.has('Foo.h'));
    assert.ok(files.has('Foo.cpp'));
  });
});
