import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { mutateText, runWithTransaction, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

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
  UserWidget: { prefix: 'U', parent: 'UUserWidget', parentInclude: 'Blueprint/UserWidget.h', moduleExtra: ['UMG'] },
  Interface: { prefix: 'U', parent: 'UInterface', parentInclude: 'UObject/Interface.h', isInterface: true, headerOnly: true },
};

function normalizeClassName(name: string, prefix: string, kind: WizardClassKind): string {
  let cleaned = name.replace(/^[^A-Za-z_]+/, '');
  if (kind === 'Interface') {
    cleaned = cleaned.replace(/^I/, '').replace(/^U/, '');
    return `U${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
  }
  if (cleaned.startsWith(prefix)) return cleaned;
  return prefix + cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function interfaceImplName(uinterfaceName: string): string {
  const base = uinterfaceName.replace(/^U/, '');
  return `I${base}`;
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
    const implName = interfaceImplName(className);
    return `#pragma once

#include "CoreMinimal.h"
#include "${meta.parentInclude}"
#include "${className}.generated.h"

UINTERFACE(MinimalAPI, BlueprintType)
class ${input.apiMacro} ${className} : public UInterface
{
\tGENERATED_BODY()
};

class ${input.apiMacro} ${implName}
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
    if (new RegExp(`"${dep}"`).test(content)) continue;
    const publicBlock = /PublicDependencyModuleNames\.AddRange\s*\(\s*new\s+string\[\]\s*\{/i;
    const privateBlock = /PrivateDependencyModuleNames\.AddRange\s*\(\s*new\s+string\[\]\s*\{/i;
    const usePublic = publicBlock.test(content);
    const blockRe = usePublic ? publicBlock : privateBlock;
    const match = content.match(blockRe);
    if (!match || match.index === undefined) continue;

    const openBrace = content.indexOf('{', match.index);
    const closeBrace = content.indexOf('}', openBrace);
    if (openBrace < 0 || closeBrace < 0) continue;

    const insertion = `\n\t\t\t"${dep}",`;
    content = content.slice(0, closeBrace) + insertion + content.slice(closeBrace);
    changed = true;
  }

  if (changed) {
    // Build.cs mutation is forbidden by workspace policy — caller must edit manually.
    return false;
  }
  return changed;
}

export async function generateClassFiles(project: UEProject, input: WizardInput) {
  return runWithTransaction(project.projectRoot, async (tx) => generateClassFilesInTx(project, input, tx));
}

async function generateClassFilesInTx(
  project: UEProject,
  input: WizardInput,
  tx: WorkspaceMutationTransaction,
) {
  const meta = KIND_META[input.kind];
  const paths = resolveWizardPaths(project, input);
  if (await fileExists(paths.publicHeader) || (!meta.headerOnly && (await fileExists(paths.privateCpp)))) {
    throw new Error(`이미 존재합니다: ${paths.className}`);
  }

  await fs.promises.mkdir(path.dirname(paths.publicHeader), { recursive: true });
  if (!meta.headerOnly) {
    await fs.promises.mkdir(path.dirname(paths.privateCpp), { recursive: true });
    await mutateText(tx, project.projectRoot, paths.privateCpp, cppTemplate(input, paths.className));
  }

  await mutateText(tx, project.projectRoot, paths.publicHeader, headerTemplate(input, paths.className));

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

export function renderWizardHeader(input: WizardInput): string {
  const meta = KIND_META[input.kind];
  const className = normalizeClassName(input.className, meta.prefix, input.kind);
  return headerTemplate(input, className);
}

export function moduleExtraDependencies(kind: WizardClassKind): string[] {
  return KIND_META[kind].moduleExtra ?? [];
}
