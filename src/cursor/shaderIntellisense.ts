import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';

export async function ensureShaderIntellisense(project: UEProject, engineRoot?: string): Promise<boolean> {
  const vscodeDir = path.join(project.projectRoot, '.vscode');
  await fs.promises.mkdir(vscodeDir, { recursive: true });
  const settingsPath = path.join(vscodeDir, 'settings.json');

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
  await fs.promises.writeFile(settingsPath, newContent, 'utf-8');
  return true;
}
