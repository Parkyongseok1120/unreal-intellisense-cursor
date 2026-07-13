import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const baseline = loadTsModule('src/diagnostics/diagnosticBaseline.ts');

describe('Gate 4 diagnostic baseline', () => {
  it('keeps source, confidence, scope and UBT evidence separate', () => {
    const project = 'C:/Projects/Game';
    const engine = 'C:/UE/UE_5.8';
    const result = baseline.createDiagnosticBaseline([
      {
        filePath: 'C:/Projects/Game/Source/Game/Private/A.cpp', line: 10, column: 3,
        severity: 'error', message: 'undeclared identifier', source: 'clangd', code: 'undeclared_var_use',
      },
      {
        filePath: 'C:/Projects/Game/Source/Game/Private/A.cpp', line: 10, column: 1,
        severity: 'error', message: 'C2065', source: 'UBT', code: 'C2065',
      },
      {
        filePath: 'C:/UE/UE_5.8/Engine/Source/Runtime/Core/Public/X.h', line: 4, column: 1,
        severity: 'warning', message: 'Included header Foo.h is not used directly', source: 'clangd', code: 'unused-includes',
      },
      {
        filePath: 'C:/Projects/Game/Source/Game/Public/A.h', line: 4, column: 1,
        severity: 'error', message: 'UHT failure', source: 'UHT', code: 'UHT001',
      },
      {
        filePath: 'C:/Projects/Game/Plugins/Foo/Source/Foo/Private/F.cpp', line: 7, column: 1,
        severity: 'warning', message: 'plugin warning', source: 'clang', code: 'x',
      },
    ], {
      projectRoot: project,
      engineRoot: engine,
      capturedAt: '2026-01-01T00:00:00.000Z',
      ubtBuild: { version: 1, completedAt: '2026-01-01T00:00:01.000Z', title: 'Build', success: true, exitCode: 0 },
    });

    assert.equal(result.summary.total, 5);
    assert.equal(result.summary.errors, 3);
    assert.equal(result.summary.byOrigin.clangd, 1);
    assert.equal(result.summary.byOrigin.ubt, 1);
    assert.equal(result.summary.byOrigin.uht, 1);
    assert.equal(result.summary.byOrigin.plugin, 1);
    const clangd = result.entries[0];
    assert.equal(clangd.confidence, 'advisory');
    assert.equal(clangd.ubtEvidence, 'matching-diagnostic');
    const engineHeader = result.entries[2];
    assert.equal(engineHeader.origin, 'engine-header');
    assert.equal(engineHeader.actionable, false);
    assert.equal(result.entries[3].confidence, 'authoritative');
    assert.equal(result.ubtBuild.success, true);
  });
});
