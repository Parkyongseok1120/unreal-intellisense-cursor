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
  /** When true, missing Build.cs deps are applied inside the transaction. */
  consentBuildCs?: boolean;
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

export function buildCsPath(project: UEProject, moduleName: string): string {
  return path.join(project.projectRoot, 'Source', moduleName, `${moduleName}.Build.cs`);
}

export async function readBuildCsContent(project: UEProject, moduleName: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(buildCsPath(project, moduleName), 'utf-8');
  } catch {
    return undefined;
  }
}

export function getMissingModuleDependencies(content: string, deps: string[]): string[] {
  return deps.filter((dep) => !new RegExp(`"${dep}"`).test(content));
}

export function previewBuildCsPatch(content: string, deps: string[]): { newContent: string; preview: string } | undefined {
  let patched = content;
  const added: string[] = [];

  for (const dep of deps) {
    if (new RegExp(`"${dep}"`).test(patched)) continue;

    const singleAdd = /(Public|Private)DependencyModuleNames\.Add\s*\(\s*"[^"]+"\s*\)/i;
    const blockRe = /(Public|Private)DependencyModuleNames\.AddRange\s*\(\s*new\s+string\[\]\s*\{/i;
    const useBlock = blockRe.test(patched);
    if (useBlock) {
      const match = patched.match(blockRe);
      if (!match || match.index === undefined) return undefined;
      const openBrace = patched.indexOf('{', match.index);
      const closeBrace = patched.indexOf('}', openBrace);
      if (openBrace < 0 || closeBrace < 0) return undefined;
      const insertion = `\n\t\t\t"${dep}",`;
      patched = patched.slice(0, closeBrace) + insertion + patched.slice(closeBrace);
      added.push(dep);
      continue;
    }

    const addMatch = patched.match(singleAdd);
    if (addMatch && addMatch.index !== undefined) {
      const lineEnd = patched.indexOf('\n', addMatch.index);
      const insertAt = lineEnd >= 0 ? lineEnd : patched.length;
      patched = `${patched.slice(0, insertAt)}\n\t\tPublicDependencyModuleNames.Add("${dep}");${patched.slice(insertAt)}`;
      added.push(dep);
      continue;
    }

    return undefined;
  }

  if (added.length === 0) return undefined;
  return {
    newContent: patched,
    preview: added.map((d) => `+ "${d}"`).join('\n'),
  };
}

export async function getMissingWizardDependencies(
  project: UEProject,
  input: WizardInput,
): Promise<string[]> {
  const meta = KIND_META[input.kind];
  if (!meta.moduleExtra?.length) return [];
  const content = await readBuildCsContent(project, input.moduleName);
  if (!content) return meta.moduleExtra;
  return getMissingModuleDependencies(content, meta.moduleExtra);
}

export async function applyBuildCsPatchInTx(
  tx: WorkspaceMutationTransaction,
  project: UEProject,
  moduleName: string,
  deps: string[],
): Promise<boolean> {
  const content = await readBuildCsContent(project, moduleName);
  if (!content) return false;
  const patch = previewBuildCsPatch(content, deps);
  if (!patch) return false;
  await mutateText(tx, project.projectRoot, buildCsPath(project, moduleName), patch.newContent, {
    consentGranted: true,
  });
  return true;
}

/** @deprecated Use getMissingWizardDependencies + applyBuildCsPatchInTx */
export async function updateBuildCsDependencies(
  project: UEProject,
  moduleName: string,
  deps: string[],
): Promise<boolean> {
  const content = await readBuildCsContent(project, moduleName);
  if (!content) return false;
  return getMissingModuleDependencies(content, deps).length === 0;
}

export async function generateClassFiles(project: UEProject, input: WizardInput) {
  const missing = await getMissingWizardDependencies(project, input);
  if (missing.length > 0 && !input.consentBuildCs) {
    throw new Error(
      `Missing module dependencies: ${missing.join(', ')}. Consent required to update ${input.moduleName}.Build.cs`,
    );
  }

  return runWithTransaction(project.projectRoot, async (tx) => generateClassFilesInTx(project, input, tx, missing));
}

async function generateClassFilesInTx(
  project: UEProject,
  input: WizardInput,
  tx: WorkspaceMutationTransaction,
  missingDeps: string[],
) {
  const meta = KIND_META[input.kind];
  const paths = resolveWizardPaths(project, input);
  if (await fileExists(paths.publicHeader) || (!meta.headerOnly && (await fileExists(paths.privateCpp)))) {
    throw new Error(`Already exists: ${paths.className}`);
  }

  if (missingDeps.length > 0 && input.consentBuildCs) {
    const applied = await applyBuildCsPatchInTx(tx, project, input.moduleName, missingDeps);
    if (!applied) {
      throw new Error(`Failed to update ${input.moduleName}.Build.cs with dependencies: ${missingDeps.join(', ')}`);
    }
  }

  if (!meta.headerOnly) {
    await mutateText(tx, project.projectRoot, paths.privateCpp, cppTemplate(input, paths.className));
  }

  await mutateText(tx, project.projectRoot, paths.publicHeader, headerTemplate(input, paths.className));

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
