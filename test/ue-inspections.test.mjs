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

const NORMAL_HEADERS = [
  `#pragma once\n#include "CoreMinimal.h"\n#include "GameFramework/Actor.h"\n#include "MyActor.generated.h"\n\nUCLASS()\nclass GAME_API AMyActor : public AActor\n{\n\tGENERATED_BODY()\npublic:\n\tAMyActor();\n};`,
  `enum class EPlainState : uint8 { A, B };`,
  `struct FPlainPod { int X; };`,
  `DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnThing);\n`,
];

describe('ueInspections', () => {
  it('has 5 enabled safe rules when inspections on', () => {
    assert.equal(inspections.inspectionRuleCount(), 5);
  });

  it('returns zero inspections when disabled', () => {
    const result = inspections.runUeInspections(NORMAL_HEADERS[0], false);
    assert.equal(result.inspections.length, 0);
  });

  it('no error false-positives on normal header corpus sample', () => {
    for (const header of NORMAL_HEADERS) {
      const result = inspections.runUeInspections(header, true);
      const errors = result.inspections.filter((i) => i.severity === 'error');
      assert.equal(errors.length, 0, `unexpected errors in: ${header.slice(0, 40)}`);
    }
  });

  it('flags Server RPC without reliability specifier', () => {
    const result = inspections.runUeInspections('UFUNCTION(Server)\nvoid Foo();', true);
    assert.ok(result.inspections.some((i) => i.id === 'ue.rpc-reliability'));
  });

  it('no error false-positives on 200-header synthetic corpus', () => {
    const headers = [...NORMAL_HEADERS];
    for (let i = 0; i < 196; i++) {
      headers.push(
        `#pragma once\n#include "CoreMinimal.h"\n#include "GameFramework/Actor.h"\n#include "Gen${i}.generated.h"\n\nUCLASS()\nclass API_${i} : public AActor\n{\n\tGENERATED_BODY()\n};`,
      );
    }
    for (const header of headers) {
      const result = inspections.runUeInspections(header, true);
      const errors = result.inspections.filter((i) => i.severity === 'error');
      assert.equal(errors.length, 0, `unexpected errors in corpus item`);
    }
  });
});
