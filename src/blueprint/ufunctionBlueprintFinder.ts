import * as vscode from 'vscode';
import { mcpCallLogical } from './mcpBlueprintBridge';
import { findBlueprintsForClass } from './blueprintFinder';
import { openAssetInEditor } from './blueprintEditor';
import type { UEInstallation, UEProject } from '../types';

export interface UFunctionBlueprintUsage {
  assetPath: string;
  assetName: string;
  nodeName?: string;
  source: 'mcp' | 'heuristic';
}

export async function findUFunctionBlueprintUsages(
  project: UEProject,
  _engine: UEInstallation | undefined,
  className: string,
  functionName: string,
): Promise<UFunctionBlueprintUsage[]> {
  const seen = new Set<string>();
  const results: UFunctionBlueprintUsage[] = [];

  const add = (u: UFunctionBlueprintUsage) => {
    const key = `${u.assetPath}::${u.nodeName ?? ''}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(u);
  };

  const res = await mcpCallLogical('findFunctionReferences', { className, functionName });
  if (res.ok && res.text) {
    for (const parsed of parseMcpUsageText(res.text)) {
      add({ ...parsed, source: 'mcp' });
    }
  }

  if (results.length === 0) {
    const bps = await findBlueprintsForClass(project.projectRoot, className);
    for (const bp of bps) {
      add({
        assetPath: bp.assetPath,
        assetName: bp.assetName,
        nodeName: functionName,
        source: 'heuristic',
      });
    }
  }

  return results;
}

function parseMcpUsageText(text: string): UFunctionBlueprintUsage[] {
  const results: UFunctionBlueprintUsage[] = [];
  try {
    const json = JSON.parse(text) as Array<Record<string, string>>;
    if (Array.isArray(json)) {
      for (const item of json) {
        const assetPath = item.assetPath ?? item.path ?? item.blueprintPath ?? item.name ?? '';
        if (!assetPath.includes('/Game/')) continue;
        results.push({
          assetPath,
          assetName: item.assetName ?? assetPath.split('/').pop()?.split('.')[0] ?? '',
          nodeName: item.nodeName ?? item.functionName,
          source: 'mcp',
        });
      }
      return results;
    }
  } catch {
    // line-based fallback
  }

  for (const line of text.split('\n')) {
    if (!line.includes('/Game/')) continue;
    const assetPath = line.trim().split(/\s+/)[0];
    const assetName = assetPath.split('/').pop()?.split('.')[0] ?? '';
    results.push({ assetPath, assetName, source: 'mcp' });
  }
  return results;
}

export async function pickAndOpenUFunctionUsage(
  project: UEProject,
  engine: UEInstallation,
  usages: UFunctionBlueprintUsage[],
): Promise<void> {
  if (usages.length === 0) return;

  let picked = usages[0];
  if (usages.length > 1) {
    const choice = await vscode.window.showQuickPick(
      usages.map((u) => ({
        label: u.assetName,
        description: u.nodeName ? `${u.nodeName} @ ${u.assetPath}` : u.assetPath,
        usage: u,
      })),
      { placeHolder: 'Blueprint 사용처 선택' },
    );
    if (!choice) return;
    picked = choice.usage;
  }

  if (picked.nodeName) {
    const highlight = await mcpCallLogical('highlightBlueprintNode', {
      assetPath: picked.assetPath,
      functionName: picked.nodeName,
    });
    if (highlight.ok) return;
  }

  await openAssetInEditor(engine, project, picked.assetPath);
}
