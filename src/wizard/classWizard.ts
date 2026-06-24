import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';

export type WizardClassKind =
  | 'Actor'
  | 'Character'
  | 'PlayerController'
  | 'ActorComponent'
  | 'GameInstance'
  | 'GameMode'
  | 'AnimInstance'
  | 'Object'
  | 'DataAsset'
  | 'UserWidget'
  | 'Interface';

export interface WizardInput {
  className: string;
  kind: WizardClassKind;
  moduleName: string;
  apiMacro: string;
  subfolder?: string;
}

interface KindMeta {
  prefix: string;
  parent: string;
  parentInclude: string;
  moduleExtra?: string[];
  isInterface?: boolean;
  headerOnly?: boolean;
}

const KIND_META: Record<WizardClassKind, KindMeta> = {
  Actor: { prefix: 'A', parent: 'AActor', parentInclude: 'GameFramework/Actor.h' },
  Character: { prefix: 'A', parent: 'ACharacter', parentInclude: 'GameFramework/Character.h', moduleExtra: ['Engine'] },
  PlayerController: { prefix: 'A', parent: 'APlayerController', parentInclude: 'GameFramework/PlayerController.h' },
  ActorComponent: { prefix: 'U', parent: 'UActorComponent', parentInclude: 'Components/ActorComponent.h' },
  GameInstance: { prefix: 'U', parent: 'UGameInstance', parentInclude: 'Engine/GameInstance.h' },
  GameMode: { prefix: 'A', parent: 'AGameModeBase', parentInclude: 'GameFramework/GameModeBase.h' },
  AnimInstance: { prefix: 'U', parent: 'UAnimInstance', parentInclude: 'Animation/AnimInstance.h' },
  Object: { prefix: 'U', parent: 'UObject', parentInclude: 'UObject/NoExportTypes.h' },
  DataAsset: { prefix: 'U', parent: 'UPrimaryDataAsset', parentInclude: 'Engine/DataAsset.h' },
  UserWidget: { prefix: 'U', parent: 'UUserWidget', parentInclude: 'Blueprint/UserWidget.h', moduleExtra: ['UMG', 'UMGEditor'] },
  Interface: { prefix: 'U', parent: 'UInterface', parentInclude: 'UObject/Interface.h', isInterface: true, headerOnly: true },
};

function normalizeClassName(name: string, prefix: string, kind: WizardClassKind): string {
  let cleaned = name.replace(/^[^A-Za-z_]+/, '');
  if (kind === 'Interface' && !cleaned.startsWith('I')) {
    cleaned = cleaned.replace(/^U/, '');
    return cleaned.startsWith('I') ? cleaned : `I${cleaned}`;
  }
  if (cleaned.startsWith(prefix)) return cleaned;
  return prefix + cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function resolveWizardPaths(project: UEProject, input: WizardInput) {
  const meta = KIND_META[input.kind];
  const className = normalizeClassName(input.className, meta.prefix, input.kind);
  const sub = input.subfolder?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '';
  const publicDir = path.join(project.projectRoot, 'Source', input.moduleName, 'Public', sub);
  const privateDir = path.join(project.projectRoot, 'Source', input.moduleName, 'Private', sub);
  return {
    publicHeader: path.join(publicDir, `${className}.h`),
    privateCpp: path.join(privateDir, `${className}.cpp`),
    className,
  };
}

function headerTemplate(input: WizardInput, className: string): string {
  const meta = KIND_META[input.kind];

  if (meta.isInterface) {
    const implName = className.startsWith('I') ? className : `I${className.replace(/^U/, '')}`;
    return `#pragma once

#include "CoreMinimal.h"
#include "${meta.parentInclude}"
#include "${className}.generated.h"

UINTERFACE(MinimalAPI, BlueprintType)
class ${input.apiMacro} ${className} : public UInterface
{
\tGENERATED_BODY()
};

class ${implName}
{
\tGENERATED_BODY()

public:
};
`;
  }

  const beginPlay =
    ['Actor', 'Character', 'ActorComponent'].includes(input.kind)
      ? `\nprotected:\n\tvirtual void BeginPlay() override;\n`
      : '';
  const tick = input.kind === 'Actor' ? `\npublic:\n\tvirtual void Tick(float DeltaTime) override;\n` : '';

  return `#pragma once

#include "CoreMinimal.h"
#include "${meta.parentInclude}"
#include "${className}.generated.h"

UCLASS()
class ${input.apiMacro} ${className} : public ${meta.parent}
{
\tGENERATED_BODY()

public:
\t${className}();${tick}${beginPlay}};
`;
}

function cppTemplate(input: WizardInput, className: string): string {
  const beginPlay = ['Actor', 'Character', 'ActorComponent'].includes(input.kind)
    ? `\nvoid ${className}::BeginPlay()\n{\n\tSuper::BeginPlay();\n}\n`
    : '';
  const tick = input.kind === 'Actor'
    ? `\nvoid ${className}::Tick(float DeltaTime)\n{\n\tSuper::Tick(DeltaTime);\n}\n`
    : '';
  const ctorBody = input.kind === 'Actor' ? `\tPrimaryActorTick.bCanEverTick = true;\n` : '';

  return `#include "${className}.h"

${className}::${className}()\n{\n${ctorBody}}\n${beginPlay}${tick}`;
}

export async function updateBuildCsDependencies(
  project: UEProject,
  moduleName: string,
  deps: string[],
): Promise<boolean> {
  const buildCs = path.join(project.projectRoot, 'Source', moduleName, `${moduleName}.Build.cs`);
  let content = '';
  try {
    content = await fs.promises.readFile(buildCs, 'utf-8');
  } catch {
    return false;
  }

  let changed = false;
  for (const dep of deps) {
    if (content.includes(`"${dep}"`)) continue;
    const insertPoint = content.indexOf('PrivateDependencyModuleNames.AddRange');
    const publicPoint = content.indexOf('PublicDependencyModuleNames.AddRange');
    const target = publicPoint >= 0 ? publicPoint : insertPoint;
    if (target < 0) continue;

    const rangeEnd = content.indexOf('});', target);
    if (rangeEnd < 0) continue;

    content = content.slice(0, rangeEnd) + `\n\t\t\t"${dep}",` + content.slice(rangeEnd);
    changed = true;
  }

  if (changed) await fs.promises.writeFile(buildCs, content, 'utf-8');
  return changed;
}

export async function generateClassFiles(project: UEProject, input: WizardInput) {
  const meta = KIND_META[input.kind];
  const paths = resolveWizardPaths(project, input);
  if (await fileExists(paths.publicHeader) || (!meta.headerOnly && (await fileExists(paths.privateCpp)))) {
    throw new Error(`이미 존재합니다: ${paths.className}`);
  }

  await fs.promises.mkdir(path.dirname(paths.publicHeader), { recursive: true });
  if (!meta.headerOnly) {
    await fs.promises.mkdir(path.dirname(paths.privateCpp), { recursive: true });
    await fs.promises.writeFile(paths.privateCpp, cppTemplate(input, paths.className), 'utf-8');
  }

  await fs.promises.writeFile(paths.publicHeader, headerTemplate(input, paths.className), 'utf-8');

  if (meta.moduleExtra?.length) {
    await updateBuildCsDependencies(project, input.moduleName, meta.moduleExtra);
  }

  return {
    className: paths.className,
    headerPath: paths.publicHeader,
    cppPath: meta.headerOnly ? '' : paths.privateCpp,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export function suggestApiMacro(moduleName: string): string {
  return `${moduleName.toUpperCase()}_API`;
}

export function moduleExtraDependencies(kind: WizardClassKind): string[] {
  return KIND_META[kind].moduleExtra ?? [];
}
