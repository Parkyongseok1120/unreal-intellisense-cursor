#!/usr/bin/env node
/**
 * Gate 5 navigation benchmark — measures class line / hierarchy / symbol ID precision.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const corpusPath = path.join(root, 'test', 'fixtures', 'navigation-corpus', 'cases.json');
const outPath =
  process.env.NAV_BENCHMARK_PATH ||
  path.join(root, 'test', 'fixtures', 'quality-metrics', 'navigation-benchmark.json');

const vscodeMock = {
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
};

function loadTsModule(relativePath, extraRequires = {}) {
  const ts = require('typescript');
  const sourcePath = path.join(root, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (id) => {
      if (extraRequires[id]) return extraRequires[id]();
      if (id === 'vscode') return vscodeMock;
      if (id.startsWith('.')) {
        const resolved = path.resolve(path.dirname(sourcePath), id);
        for (const candidate of [`${resolved}.ts`, `${resolved}.js`, resolved]) {
          if (fs.existsSync(candidate)) return loadTsModule(path.relative(root, candidate), extraRequires);
        }
      }
      return require(id);
    },
    __dirname: path.dirname(sourcePath),
    __filename: sourcePath,
    process,
    Buffer,
  };
  require('node:vm').runInNewContext(js, sandbox, { filename: sourcePath });
  return module.exports;
}

const cppParser = loadTsModule('src/blueprint/cppClassParser.ts');
const symbolModel = loadTsModule('src/projectModel/symbolModel.ts');
const generatedParser = loadTsModule('src/uht/generatedHeaderParser.ts');
const symbolModelEnrich = symbolModel.enrichReflectionFromHeaderContent;

function evaluateClassLineCases(cases) {
  let correct = 0;
  const failures = [];
  for (const c of cases) {
    const parsed = cppParser.parseUClassFromText(c.header).find((p) => p.className === c.className);
    const actualLine = parsed?.line;
    const actualParent = parsed?.parentClass;
    const lineOk = actualLine === c.expectedClassLine;
    const parentOk = !c.expectedParent || actualParent === c.expectedParent;
    if (lineOk && parentOk) correct++;
    else failures.push({ id: c.id, expectedLine: c.expectedClassLine, actualLine, expectedParent: c.expectedParent, actualParent });
  }
  return { correct, total: cases.length, failures, precision: cases.length ? correct / cases.length : 0 };
}

function evaluateReflectionEnrichment(cases) {
  let correct = 0;
  const failures = [];
  for (const c of cases) {
    const reflection = {
      className: c.className,
      filePath: `C:/Synthetic/${c.className}.h`,
      properties: [{ name: 'DummyProp', line: 99 }],
      functions: [],
    };
    symbolModelEnrich(reflection, c.header, reflection.filePath);
    const lineOk = reflection.classLine === c.expectedClassLine;
    if (lineOk && reflection.declarationRange) correct++;
    else failures.push({ id: c.id, classLine: reflection.classLine, expected: c.expectedClassLine });
  }
  return { correct, total: cases.length, failures, precision: cases.length ? correct / cases.length : 0 };
}

function evaluateSymbolIdCases(cases) {
  let correct = 0;
  for (const c of cases) {
    const id = symbolModel.buildStableSymbolId(c.module, c.className, c.sourceFile);
    if (id === c.expectedId) correct++;
  }
  return { correct, total: cases.length, precision: cases.length ? correct / cases.length : 1 };
}

function evaluateHierarchyCases(cases, classCases) {
  const classByName = new Map();
  for (const c of classCases) {
    for (const parsed of cppParser.parseUClassFromText(c.header)) {
      classByName.set(parsed.className, { ...parsed, caseId: c.id });
    }
  }

  let correct = 0;
  const failures = [];
  for (const h of cases) {
    const childParsed = classByName.get(h.child);
    const parentParsed = classByName.get(h.parent);
    if (
      childParsed?.parentClass === h.parent &&
      childParsed?.line === h.childLine &&
      parentParsed?.line === h.parentLine
    ) {
      correct++;
    } else {
      failures.push({
        id: h.id,
        childLine: childParsed?.line,
        parentLine: parentParsed?.line,
        parentClass: childParsed?.parentClass,
      });
    }
  }
  return { correct, total: cases.length, failures, precision: cases.length ? correct / cases.length : 1 };
}

function evaluateReferenceCases(cases) {
  if (!cases?.length) return { precision: 1, recall: 1, correct: 0, total: 0, failures: [] };

  const refNav = loadTsModule('src/navigation/referenceNavigation.ts', {
    '../parsers/moduleLayout': () => ({
      findPairedSourceFile: (file) => (file.endsWith('.h') ? file.replace(/\.h$/i, '.cpp') : undefined),
    }),
    './symbolNavigation': () => ({
      findEnclosingUeClass: () => undefined,
    }),
  });

  let correct = 0;
  let expectedTotal = 0;
  const failures = [];

  for (const c of cases) {
    const headerPath = path.join(root, 'test', 'fixtures', 'navigation-corpus', `bench-${c.id}.h`);
    const cppPath = path.join(root, 'test', 'fixtures', 'navigation-corpus', `bench-${c.id}.cpp`);
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

    const locations = refNav.findUeReferences(document, { line: symbolLine, character: symbolCol }, { moduleScan: false });
    expectedTotal += c.expectedLocations ?? 1;
    if (locations.length >= (c.expectedLocations ?? 1)) {
      correct += c.expectedLocations ?? 1;
    } else {
      failures.push({ id: c.id, expected: c.expectedLocations ?? 1, actual: locations.length });
    }
  }

  const precision = expectedTotal ? correct / expectedTotal : 1;
  const recall = cases.length ? correct / (cases.reduce((s, c) => s + (c.expectedLocations ?? 1), 0)) : 1;
  return { precision, recall, correct, total: expectedTotal, failures };
}

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
const classLine = evaluateClassLineCases(corpus.cases);
const enrichment = evaluateReflectionEnrichment(corpus.cases);
const symbolIds = evaluateSymbolIdCases(corpus.symbolIdCases ?? []);
const hierarchy = evaluateHierarchyCases(corpus.hierarchyCases ?? [], corpus.cases);
const references = evaluateReferenceCases(corpus.referenceCases ?? []);

const definitionPrecision = (classLine.precision + enrichment.precision) / 2;
const hierarchyAccuracy = hierarchy.precision;

const result = {
  version: 1,
  generatedAt: new Date().toISOString(),
  corpusVersion: corpus.version,
  metrics: {
    definitionPrecision,
    classLinePrecision: classLine.precision,
    enrichmentPrecision: enrichment.precision,
    symbolIdPrecision: symbolIds.precision,
    hierarchyAccuracy,
    referencePrecision: references.precision,
    referenceRecall: references.recall,
  },
  counts: {
    classLine: classLine,
    enrichment,
    symbolIds,
    hierarchy,
    references,
  },
  thresholds: corpus.thresholds,
  passed:
    definitionPrecision >= corpus.thresholds.definitionPrecision &&
    hierarchyAccuracy >= corpus.thresholds.hierarchyAccuracy &&
    references.precision >= (corpus.thresholds.referencePrecision ?? 0.98) &&
    references.recall >= (corpus.thresholds.referenceRecall ?? 0.85),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
console.log(`[benchmark-navigation] definitionPrecision=${(definitionPrecision * 100).toFixed(1)}% hierarchy=${(hierarchyAccuracy * 100).toFixed(1)}% -> ${outPath}`);
process.exit(result.passed ? 0 : 1);
