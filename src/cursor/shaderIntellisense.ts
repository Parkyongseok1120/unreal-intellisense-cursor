import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UEProject } from '../types';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { virtualShaderIncludeRoots } from '../hlsl/shaderCompileWorker';

const HLSL_TOOLS_EXTENSION_ID = 'nvidia.hlsl-tools';

export async function verifyHlslToolsExtension(): Promise<{ installed: boolean; active: boolean }> {
  const ext = vscode.extensions.getExtension(HLSL_TOOLS_EXTENSION_ID);
  if (!ext) return { installed: false, active: false };
  if (!ext.isActive) {
    try {
      await ext.activate();
    } catch {
      return { installed: true, active: false };
    }
  }
  return { installed: true, active: ext.isActive };
}

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

  const virtualRoots = virtualShaderIncludeRoots(project.projectRoot, engineRoot);
  const shaderPaths: string[] = [
    ...Object.values(virtualRoots),
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
    'hlsl.includePaths': [...new Set(shaderPaths)],
    'hlsl.virtualShaderRoots': virtualRoots,
    'hlsl.defines': {
      ...(existing['hlsl.defines'] as object),
      PLATFORM_WINDOWS: '1',
      PLATFORM_DESKTOP: '1',
      UE_BUILD_DEVELOPMENT: '1',
      UE_BUILD_SHIPPING: '0',
      WITH_EDITOR: '1',
    },
    '[hlsl]': {
      'editor.wordBasedSuggestions': 'off',
    },
    'hlsl.suppressValidation': false,
    'hlsl.preferredLanguageServer': 'hlsl-tools',
  };

  const merged = { ...existing, ...shaderSettings };
  const newContent = JSON.stringify(merged, null, 2) + '\n';
  const oldContent = JSON.stringify(existing, null, 2) + '\n';
  if (newContent === oldContent) return false;
  await mutateJson(tx, project.projectRoot, settingsPath, merged);
  return true;
}
