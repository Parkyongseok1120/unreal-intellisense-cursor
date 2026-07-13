#!/usr/bin/env node
/**
 * Expands navigation/UHT corpus fixtures to Gate 5 target sizes (50+ nav, 30+ UHT).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const navPath = path.join(root, 'test', 'fixtures', 'navigation-corpus', 'cases.json');
const uhtPath = path.join(root, 'test', 'fixtures', 'uht-corpus', 'cases.json');

const PARENTS = [
  ['AActor', 'GameFramework/Actor.h'],
  ['APawn', 'GameFramework/Pawn.h'],
  ['ACharacter', 'GameFramework/Character.h'],
  ['APlayerController', 'GameFramework/PlayerController.h'],
  ['AGameModeBase', 'GameFramework/GameModeBase.h'],
  ['UActorComponent', 'Components/ActorComponent.h'],
  ['USceneComponent', 'Components/SceneComponent.h'],
  ['UGameInstanceSubsystem', 'Subsystems/GameInstanceSubsystem.h'],
  ['UUserWidget', 'Blueprint/UserWidget.h'],
  ['UObject', 'UObject/Object.h'],
  ['UDataAsset', 'Engine/DataAsset.h'],
  ['UAnimInstance', 'Animation/AnimInstance.h'],
  ['AHUD', 'GameFramework/HUD.h'],
  ['UWorldSubsystem', 'Subsystems/WorldSubsystem.h'],
  ['UInterface', 'UObject/Interface.h'],
];

function makeClassCase(id, className, parent, parentInclude, extraIncludes = 2) {
  const includes = ['#pragma once', '#include "CoreMinimal.h"'];
  for (let i = 0; i < extraIncludes - 1; i++) includes.push(`#include "Extra${i}.h"`);
  includes.push(`#include "${parentInclude}"`);
  includes.push(`#include "${className}.generated.h"`);
  includes.push('');
  includes.push('UCLASS()');
  includes.push(`class MYGAME_API ${className} : public ${parent}`);
  includes.push('{');
  includes.push('\tGENERATED_BODY()');
  includes.push('};');
  const header = includes.join('\n');
  const expectedClassLine = includes.findIndex((l) => l.startsWith('class MYGAME_API'));
  return { id, header, className, expectedClassLine, expectedParent: parent };
}

const baseNav = JSON.parse(fs.readFileSync(navPath, 'utf-8'));
const BASE_CLASS_CASES = baseNav.cases.filter((c) => !c.id.startsWith('gen-') && !c.id.startsWith('hier-gen-'));
const generatedCases = [...BASE_CLASS_CASES];
let idx = generatedCases.length;

for (const [parent, inc] of PARENTS) {
  for (let v = 0; v < 3; v++) {
    const className = `AGen${parent.replace(/^./, '')}${v}`;
    if (generatedCases.some((c) => c.className === className)) continue;
    generatedCases.push(makeClassCase(`gen-${parent.toLowerCase()}-${v}`, className, parent, inc, 2 + v));
    idx++;
  }
}

// Multi-class hierarchy cases
const hierarchyCases = (baseNav.hierarchyCases ?? []).filter((h) => !h.id.startsWith('hier-case-') && h.id !== 'hierarchy-multi-inherit');
hierarchyCases.push({
  id: 'hierarchy-multi-inherit',
  child: 'ASecondActor',
  parent: 'AFirstActor',
  childLine: 10,
  parentLine: 4,
});
for (let h = 0; h < 10; h++) {
  const child = `AHierChild${h}`;
  const parent = `AHierParent${h}`;
  const header = `#pragma once\n#include "CoreMinimal.h"\n\nUCLASS()\nclass MYGAME_API ${parent} : public AActor\n{\n\tGENERATED_BODY()\n};\n\nUCLASS()\nclass MYGAME_API ${child} : public ${parent}\n{\n\tGENERATED_BODY()\n};`;
  const childLine = header.split('\n').findIndex((l) => l.includes(`class MYGAME_API ${child}`));
  const parentLine = header.split('\n').findIndex((l) => l.includes(`class MYGAME_API ${parent}`));
  if (!generatedCases.some((c) => c.className === child)) {
    generatedCases.push({ id: `hier-gen-${h}`, header, className: child, expectedClassLine: childLine, expectedParent: parent });
    hierarchyCases.push({ id: `hier-case-${h}`, child, parent, childLine, parentLine });
  }
}

const symbolIdCases = [
  {
    module: 'MyGame',
    className: 'AMyActor',
    sourceFile: 'C:/Project/Source/MyGame/Public/MyActor.h',
    expectedId: 'MyGame@AMyActor@c:/project/source/mygame/public/myactor.h',
  },
];
for (let s = 0; s < 10; s++) {
  symbolIdCases.push({
    module: `Mod${s}`,
    className: `ASym${s}`,
    sourceFile: `C:/Project/Source/Mod${s}/Public/Sym${s}.h`,
    expectedId: `Mod${s}@ASym${s}@c:/project/source/mod${s}/public/sym${s}.h`,
  });
}

const referenceCases = [];
for (let r = 0; r < 15; r++) {
  const sym = `RefSym${r}`;
  const header = `#pragma once\n#include "CoreMinimal.h"\n\nUCLASS()\nclass MYGAME_API ARef${r} : public AActor\n{\n\tGENERATED_BODY()\npublic:\n\tvoid Use${sym}();\n\tint32 ${sym};\n};`;
  const cpp = `#include "ARef${r}.h"\nvoid ARef${r}::Use${sym}() { ${sym} = 1; }\n`;
  referenceCases.push({
    id: `ref-${r}`,
    header,
    cpp,
    symbol: sym,
    expectedLocations: 2,
  });
}

const navOut = {
  ...baseNav,
  version: 2,
  cases: generatedCases,
  hierarchyCases,
  symbolIdCases,
  referenceCases,
};
fs.writeFileSync(navPath, JSON.stringify(navOut, null, 2) + '\n', 'utf-8');

const baseUht = JSON.parse(fs.readFileSync(uhtPath, 'utf-8'));
const authCases = baseUht.authoritativeCases.filter((c) => !c.id.startsWith('uht-synth-'));
for (let a = 0; a < 27; a++) {
  authCases.push({
    id: `uht-synth-${a}`,
    output: `C:/Project/Source/Game/Public/Synth${a}.h(${8 + (a % 5)}): error C${4000 + a}: synthetic UHT error ${a}`,
    expectedFile: `C:/Project/Source/Game/Public/Synth${a}.h`,
    expectedLine: 8 + (a % 5),
    severity: 'error',
  });
}

const inspectionCases = baseUht.inspectionCases.filter((c) => !c.id.startsWith('inspection-valid-batch-'));
const validHeader = inspectionCases[0].header;
for (let i = 0; i < 20; i++) {
  inspectionCases.push({
    id: `inspection-valid-batch-${i}`,
    header: validHeader.replace('AGoodActor', `AGoodActor${i}`),
    expectErrors: 0,
    expectWarnings: 0,
  });
}

const uhtOut = {
  ...baseUht,
  version: 2,
  authoritativeCases: authCases,
  inspectionCases,
};
fs.writeFileSync(uhtPath, JSON.stringify(uhtOut, null, 2) + '\n', 'utf-8');

console.log(`[expand-corpus] nav cases=${navOut.cases.length} hierarchy=${navOut.hierarchyCases.length} refs=${navOut.referenceCases.length}`);
console.log(`[expand-corpus] uht auth=${uhtOut.authoritativeCases.length} inspection=${uhtOut.inspectionCases.length}`);
