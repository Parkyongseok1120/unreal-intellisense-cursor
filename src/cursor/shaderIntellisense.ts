import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

export async function ensureShaderIntellisense(
  project: UEProject,
  engineRoot?: string,
  tx?: WorkspaceMutationTransaction,
): Promise<boolean> {
  const settingsPath = path.join(project.projectRoot, '.vscode', 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  const shaderPaths: string[] = [
    path.join(project.projectRoot, 'Shaders').replace(/\\/g, '/'),
    path.join(project.projectRoot, 'Plugins').replace(/\\/g, '/'),
  ];
  if (engineRoot) {
    shaderPaths.push(path.join(engineRoot, 'Engine', 'Shaders').replace(/\\/g, '/'));
  }

  const shaderSettings: Record<string, unknown> = {
    'files.associations': {
      ...(existing['files.associations'] as object),
      '*.usf': 'hlsl',
      '*.ush': 'hlsl',
      '*.usfinc': 'hlsl',
    },
    'hlsl.includePaths': shaderPaths,
    '[hlsl]': {
      'editor.wordBasedSuggestions': 'off',
    },
  };

  const merged = { ...existing, ...shaderSettings };
  const newContent = JSON.stringify(merged, null, 2) + '\n';
  const oldContent = JSON.stringify(existing, null, 2) + '\n';
  if (newContent === oldContent) return false;
  await mutateJson(tx, project.projectRoot, settingsPath, merged);
  return true;
}
