import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const inspections = loadTsModule('src/uht/ueInspections.ts', {
  vscode: () => ({
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Range: class {},
    Diagnostic: class {},
    Uri: { file: (p) => ({ fsPath: p }) },
  }),
});

describe('ueInspections', () => {
  it('exposes 12 inspection rules', () => {
    assert.equal(inspections.inspectionRuleCount(), 12);
  });

  it('flags missing UENUM on reflected enum', () => {
    const result = inspections.runUeInspections('enum class EMyState : uint8\n{\n\tA\n};');
    assert.ok(result.inspections.some((i) => i.id === 'ue.uenum-missing'));
  });

  it('flags Server RPC without reliability specifier', () => {
    const result = inspections.runUeInspections('UFUNCTION(Server)\nvoid Foo();');
    assert.ok(result.inspections.some((i) => i.id === 'ue.rpc-server-spec'));
  });

  it('does not flag Server RPC with Reliable', () => {
    const result = inspections.runUeInspections('UFUNCTION(Server, Reliable)\nvoid Foo();');
    assert.equal(result.inspections.filter((i) => i.id === 'ue.rpc-server-spec').length, 0);
  });
});
