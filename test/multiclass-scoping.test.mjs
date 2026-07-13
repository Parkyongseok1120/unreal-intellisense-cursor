import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const parser = loadTsModule('src/uht/generatedHeaderParser.ts', {
  '../blueprint/cppClassParser': () => loadTsModule('src/blueprint/cppClassParser.ts'),
});

const SHARED_HEADER = `#pragma once
#include "CoreMinimal.h"

UCLASS()
class MYGAME_API ASharedOwner : public AActor
{
  GENERATED_BODY()
public:
  UPROPERTY()
  int32 SharedOnlyProp;
};

UCLASS()
class MYGAME_API AUniqueChild : public ASharedOwner
{
  GENERATED_BODY()
public:
  UPROPERTY()
  float ChildOnlyProp;
};
`;

describe('multi-UCLASS member scoping', () => {
  it('scopes UPROPERTY members to the owning class body', () => {
    const owner = parser.parseHeaderMembersForClass(SHARED_HEADER, 'ASharedOwner');
    const child = parser.parseHeaderMembersForClass(SHARED_HEADER, 'AUniqueChild');
    assert.equal(owner.properties.map((p) => p.name).join(','), 'SharedOnlyProp');
    assert.equal(child.properties.map((p) => p.name).join(','), 'ChildOnlyProp');
  });

  it('parses multiple generated classes from one file', () => {
    const generated = `
class ASharedOwner : public AActor
{
  static const UECodeGen_Private::FMetaDataPairParam SharedOnlyProp_MetaData[];
};
class AUniqueChild : public ASharedOwner
{
  static const UECodeGen_Private::FMetaDataPairParam ChildOnlyProp_MetaData[];
};
`;
    const classes = parser.parseGeneratedHeader(generated, 'C:/Proj/Intermediate/ASharedOwner.generated.h');
    assert.equal(classes.length, 2);
    assert.equal(classes[0].properties.map((p) => p.name).join(','), 'SharedOnlyProp');
    assert.equal(classes[1].properties.map((p) => p.name).join(','), 'ChildOnlyProp');
  });
});
