import * as fs from 'fs';
import * as path from 'path';
import type { BuildTargetType, UEProject } from '../types';
import { TARGET_SUFFIXES } from '../constants';

export interface DiscoveredTarget {
  name: string;
  path: string;
}

export function discoverTargetsSync(projectRoot: string): DiscoveredTarget[] {
  const targets: DiscoveredTarget[] = [];
  const sourceDir = path.join(projectRoot, 'Source');
  if (!fs.existsSync(sourceDir)) return targets;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return targets;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.Target.cs')) continue;
    targets.push({
      name: entry.name.replace('.Target.cs', ''),
      path: path.join(sourceDir, entry.name),
    });
  }
  return targets;
}

export function resolveEditorTargetName(project: UEProject): string {
  const targets = discoverTargetsSync(project.projectRoot);
  const editor = targets.find((t) => t.name.endsWith('Editor'));
  if (editor) return editor.name;
  return project.name + (TARGET_SUFFIXES.Editor ?? 'Editor');
}

export function resolveGameTargetName(project: UEProject): string {
  const targets = discoverTargetsSync(project.projectRoot);
  const gameTargets = targets.filter((t) => !t.name.endsWith('Editor') && !t.name.endsWith('Server'));
  if (gameTargets.length === 1) return gameTargets[0].name;

  const moduleName = project.modules[0]?.Name;
  if (moduleName) {
    const byModule = gameTargets.find((t) => t.name === moduleName || t.name.startsWith(moduleName));
    if (byModule) return byModule.name;
  }

  const nonEditor = gameTargets[0];
  if (nonEditor) return nonEditor.name;
  return project.name;
}

export function resolveTargetName(project: UEProject, targetType: BuildTargetType): string {
  if (targetType === 'Editor') return resolveEditorTargetName(project);
  if (targetType === 'Game') return resolveGameTargetName(project);
  if (targetType === 'Server') {
    const game = resolveGameTargetName(project);
    return game.endsWith('Server') ? game : `${game}Server`;
  }
  return project.name + (TARGET_SUFFIXES[targetType] ?? '');
}
