#!/usr/bin/env node
/**
 * Gate 5 UHT benchmark — authoritative parse accuracy + heuristic FP rate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const corpusPath = path.join(root, 'test', 'fixtures', 'uht-corpus', 'cases.json');
const outPath =
  process.env.UHT_BENCHMARK_PATH ||
  path.join(root, 'test', 'fixtures', 'quality-metrics', 'uht-benchmark.json');

function loadTsModule(relativePath, extra = {}) {
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
      if (extra[id]) return extra[id]();
      if (id.startsWith('.')) {
        const resolved = path.resolve(path.dirname(sourcePath), id);
        for (const candidate of [`${resolved}.ts`, `${resolved}.js`, resolved]) {
          if (fs.existsSync(candidate)) return loadTsModule(path.relative(root, candidate), extra);
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

const uhtRunner = loadTsModule('src/uht/uhtRunner.ts');
const ueInspections = loadTsModule('src/uht/ueInspections.ts', {
  vscode: () => ({
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Range: class { constructor(a, b, c, d) { this.start = a; this.end = c; } },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
  }),
});

function evaluateAuthoritative(cases) {
  let recall = 0;
  let location = 0;
  for (const c of cases) {
    const diags = uhtRunner.parseUhtOutput(c.output);
    const match = diags.find((d) => path.normalize(d.file).toLowerCase() === path.normalize(c.expectedFile).toLowerCase());
    if (match) recall++;
    if (match && match.line === c.expectedLine && match.severity === c.severity) location++;
  }
  return {
    recall: cases.length ? recall / cases.length : 1,
    locationAccuracy: cases.length ? location / cases.length : 1,
  };
}

function evaluateInspections(cases) {
  let errorFp = 0;
  let warningFp = 0;
  let errorChecks = 0;
  let warningChecks = 0;
  for (const c of cases) {
    const result = ueInspections.runUeInspections(c.header, true);
    const errors = result.inspections.filter((i) => i.severity === 'error').length;
    const warnings = result.inspections.filter((i) => i.severity === 'warning').length;
    if (c.expectErrors === 0) {
      errorChecks++;
      if (errors > 0) errorFp++;
    }
    if (c.expectWarnings === 0) {
      warningChecks++;
      if (warnings > 0) warningFp++;
    }
  }
  return {
    heuristicErrorFalsePositive: errorFp,
    heuristicWarningFalsePositiveRate: warningChecks ? warningFp / warningChecks : 0,
  };
}

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
const auth = evaluateAuthoritative(corpus.authoritativeCases);
const insp = evaluateInspections(corpus.inspectionCases);

const result = {
  version: 1,
  generatedAt: new Date().toISOString(),
  metrics: {
    uhtErrorRecall: auth.recall,
    uhtLocationAccuracy: auth.locationAccuracy,
    heuristicErrorFalsePositive: insp.heuristicErrorFalsePositive,
    heuristicWarningFalsePositiveRate: insp.heuristicWarningFalsePositiveRate,
  },
  thresholds: corpus.thresholds,
  passed:
    auth.recall >= corpus.thresholds.uhtErrorRecall &&
    auth.locationAccuracy >= corpus.thresholds.uhtLocationAccuracy &&
    insp.heuristicErrorFalsePositive <= corpus.thresholds.heuristicErrorFalsePositive &&
    insp.heuristicWarningFalsePositiveRate <= corpus.thresholds.heuristicWarningFalsePositiveRate,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
console.log(`[benchmark-uht] recall=${(auth.recall * 100).toFixed(1)}% location=${(auth.locationAccuracy * 100).toFixed(1)}% -> ${outPath}`);
process.exit(result.passed ? 0 : 1);
