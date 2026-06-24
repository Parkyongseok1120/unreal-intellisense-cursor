import { spawn } from 'child_process';
import type { UEInstallation, UEProject } from '../types';
import { mcpCallLogical } from './mcpBlueprintBridge';

function quoteForExecCmds(value: string): string {
  return value.replace(/\\/g, '/').replace(/'/g, "\\'");
}

/** 에디터에서 에셋 열기 — MCP 우선, fallback -ExecCmds */
export async function openAssetInEditor(
  engine: UEInstallation,
  project: UEProject,
  assetPath: string,
): Promise<void> {
  const mcpResult = await mcpCallLogical('openAsset', { path: assetPath });
  if (mcpResult?.ok) return;

  const cmd = `py import unreal; unreal.EditorAssetLibrary.load_asset('${quoteForExecCmds(assetPath)}'); unreal.EditorAssetLibrary.open_editor_for_assets([unreal.EditorAssetLibrary.load_asset('${quoteForExecCmds(assetPath)}')])`;
  spawnEditorWithExecCmds(engine, project, cmd);
}

/** Blueprint 서브클래스 생성 — MCP / Python ExecCmds */
export async function createBlueprintSubclassInEditor(
  engine: UEInstallation,
  project: UEProject,
  parentClassName: string,
  blueprintName?: string,
): Promise<void> {
  const bpName = blueprintName ?? `BP_${parentClassName.replace(/^[AU]/, '')}`;
  const parent = parentClassName.startsWith('/') ? parentClassName : `/Script/Engine.${parentClassName}`;

  const mcpResult = await mcpCallLogical('createBlueprint', {
    parentClass: parentClassName,
    name: bpName,
  });
  if (mcpResult?.ok) return;

  const cmd = [
    'py import unreal',
    `parent = unreal.load_class(None, '${quoteForExecCmds(parent)}')`,
    `factory = unreal.BlueprintFactory()`,
    `factory.set_editor_property('parent_class', parent)`,
    `asset_tools = unreal.AssetToolsHelpers.get_asset_tools()`,
    `asset_tools.create_asset('${quoteForExecCmds(bpName)}', '/Game', unreal.Blueprint, factory)`,
  ].join('; ');

  spawnEditorWithExecCmds(engine, project, cmd);
}

export function spawnEditorWithExecCmds(
  engine: UEInstallation,
  project: UEProject,
  execCmd: string,
): void {
  const proc = spawn(
    engine.editorPath,
    [project.uprojectPath, `-ExecCmds=${execCmd}`],
    { detached: true, stdio: 'ignore', cwd: project.projectRoot },
  );
  proc.unref();
}
