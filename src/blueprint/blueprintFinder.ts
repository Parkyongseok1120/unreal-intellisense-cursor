import * as fs from 'fs';
import * as path from 'path';
import { mcpFindBlueprintsForClass } from './mcpBlueprintBridge';
import { blueprintNameCandidates } from './cppClassParser';
import { getCachedBlueprints, setCachedBlueprints } from './blueprintCache';
import { contentToAssetPath, findUassetsRecursive } from '../assets/assetIndex';
import type { BridgeBlueprintEntry } from '../editorBridge/editorBridgeClient';
import type { BlueprintAsset } from './types';
export type { BlueprintAsset } from './types';

async function findUassetsInContent(contentDir: string, depth: number): Promise<string[]> {
  const results: string[] = [];
  await findUassetsRecursive(contentDir, depth, results);
  return results;
}
export async function findBlueprintsForClass(
  projectRoot: string,
  className: string,
  bridge?: { listDerivedBlueprints: (parent: string) => Promise<BridgeBlueprintEntry[]> },
): Promise<BlueprintAsset[]> {
  const cached = getCachedBlueprints(projectRoot, className);
  if (cached) return cached;

  const seen = new Set<string>();
  const matches: BlueprintAsset[] = [];

  const add = (bp: BlueprintAsset) => {
    const key = bp.assetPath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(bp);
  };

  if (bridge) {
    try {
      const derived = await bridge.listDerivedBlueprints(className);
      for (const bp of derived) {
        add({
          assetPath: bp.assetPath,
          assetName: bp.assetPath.split('/').pop()?.split('.')[0] ?? bp.parentClass ?? bp.assetPath,
          source: 'bridge',
        });
      }
    } catch {
      // bridge optional
    }
  }

  // Tier 3: MCP-first (에디터 실행 시 정확한 매칭)
  const mcpResults = await mcpFindBlueprintsForClass(className);
  for (const bp of mcpResults) add({ ...bp, source: 'mcp' });

  const contentDir = path.join(projectRoot, 'Content');
  const allUassets = await findUassetsInContent(contentDir, 12);

  const candidates = new Set(blueprintNameCandidates(className).map((c) => c.toLowerCase()));

  for (const filePath of allUassets) {
    const assetName = path.basename(filePath, '.uasset');
    if (!candidates.has(assetName.toLowerCase())) continue;
    const relFromContent = path.relative(contentDir, filePath);
    add({
      assetPath: contentToAssetPath(path.join('Content', relFromContent), assetName),
      filePath,
      assetName,
      source: 'filesystem',
    });
  }

  setCachedBlueprints(projectRoot, className, matches);
  return matches;
}

export async function findCppClassForBlueprintName(
  projectRoot: string,
  blueprintName: string,
): Promise<string[]> {
  const stripped = blueprintName
    .replace(/^BP_/i, '')
    .replace(/^BPI_/i, '')
    .replace(/^WBP_/i, '')
    .replace(/^ABP_/i, '');

  const patterns = [`A${stripped}`, `U${stripped}`, stripped];
  const sourceDir = path.join(projectRoot, 'Source');
  const results: string[] = [];

  async function scanDir(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && (entry.name.endsWith('.h') || entry.name.endsWith('.cpp'))) {
          const base = path.basename(entry.name, path.extname(entry.name));
          if (patterns.some((p) => p.toLowerCase() === base.toLowerCase())) {
            results.push(full);
          }
        } else if (entry.isDirectory()) {
          await scanDir(full, depth - 1);
        }
      }
    } catch {
      // ignore
    }
  }

  await scanDir(sourceDir, 10);
  const pluginsDir = path.join(projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const p of plugins) {
      if (p.isDirectory()) await scanDir(path.join(pluginsDir, p.name, 'Source'), 8);
    }
  } catch {
    // no plugins
  }

  return [...new Set(results)];
}

/** BP 에셋명으로 Content 내 .uasset 검색 (양방향 점프) */
export async function findBlueprintAssetByName(
  projectRoot: string,
  assetName: string,
): Promise<BlueprintAsset | undefined> {
  const bps = await findBlueprintsForClass(projectRoot, assetName.replace(/^BP_/i, ''));
  return bps.find((b) => b.assetName.toLowerCase() === assetName.toLowerCase()) ?? bps[0];
}
