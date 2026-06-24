import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readRegistryValue, enumerateRegistrySubKeys, readRegistryKeyValues } from '../platform/registry';
import { fileExists, resolveUBTPath, resolveEditorPath } from '../platform/paths';
import { Registry, COMMON_ENGINE_PATHS, SUPPORTED_ENGINE_VERSION } from '../constants';
import type { UEInstallation, UEProject } from '../types';

function isUE58Version(version: string): boolean {
  return version === SUPPORTED_ENGINE_VERSION || version.startsWith('5.8.');
}

export async function discoverEngines(): Promise<UEInstallation[]> {
  const installations: UEInstallation[] = [];
  const seen = new Set<string>();

  const add = (install: UEInstallation | undefined) => {
    if (!install || !isUE58Version(install.version)) return;
    const key = install.root.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      installations.push(install);
    }
  };

  for (const install of await scanLauncherInstalls()) add(install);
  for (const install of await scanSourceBuilds()) add(install);
  for (const install of await scanCommonPaths()) add(install);

  return installations;
}

async function scanLauncherInstalls(): Promise<UEInstallation[]> {
  const installations: UEInstallation[] = [];
  const versions = await enumerateRegistrySubKeys(Registry.LauncherInstalls);
  for (const version of versions) {
    const installDir = await readRegistryValue(`${Registry.LauncherInstalls}\\${version}`, 'InstalledDirectory');
    if (installDir) {
      const install = await buildInstallation(installDir, version, 'registry', false);
      if (install) installations.push(install);
    }
  }
  return installations;
}

async function scanSourceBuilds(): Promise<UEInstallation[]> {
  const installations: UEInstallation[] = [];
  const builds = await readRegistryKeyValues(Registry.SourceBuilds);
  for (const [guid, engineRoot] of builds) {
    const install = await buildInstallation(engineRoot, guid, 'registry', true);
    if (install) installations.push(install);
  }
  return installations;
}

async function scanCommonPaths(): Promise<UEInstallation[]> {
  const installations: UEInstallation[] = [];
  for (const basePath of COMMON_ENGINE_PATHS) {
    try {
      const entries = await fs.promises.readdir(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === 'UE_5.8' || entry.name.startsWith('UE_5.8'))) {
          const engineRoot = path.join(basePath, entry.name);
          const version = entry.name.replace('UE_', '');
          const install = await buildInstallation(engineRoot, version, 'path-scan', false);
          if (install) installations.push(install);
        }
      }
    } catch {
      // not readable
    }
  }
  return installations;
}

async function buildInstallation(
  root: string,
  version: string,
  source: UEInstallation['source'],
  isSourceBuild: boolean,
): Promise<UEInstallation | undefined> {
  const ubtPath = resolveUBTPath(root);
  if (!(await fileExists(ubtPath))) return undefined;
  return {
    version,
    root,
    source,
    ubtPath,
    editorPath: resolveEditorPath(root),
    isSourceBuild,
  };
}

export async function findMatchingEngine(
  project: UEProject,
  installations: UEInstallation[],
): Promise<UEInstallation | undefined> {
  const assoc = project.engineAssociation;
  if (!assoc) return undefined;

  if (assoc.startsWith('{') && assoc.endsWith('}')) {
    return installations.find((i) => i.isSourceBuild && i.version === assoc);
  }
  return installations.find((i) => !i.isSourceBuild && (i.version === assoc || i.version.startsWith(assoc)));
}

export async function promptSelectEngine(installations: UEInstallation[]): Promise<UEInstallation | undefined> {
  if (installations.length === 0) {
    vscode.window.showErrorMessage(
      'UE5_8 Cursor: UE 5.8 엔진을 찾을 수 없습니다. ue58rider.engineRoot 설정을 확인하세요.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    installations.map((i) => ({
      label: `UE ${i.version}`,
      description: i.root,
      detail: i.isSourceBuild ? '소스 빌드' : '런처 설치',
      installation: i,
    })),
    { placeHolder: 'UE 5.8 엔진 선택' },
  );
  return picked?.installation;
}

export async function createManualInstallation(engineRoot: string): Promise<UEInstallation | undefined> {
  return buildInstallation(engineRoot, SUPPORTED_ENGINE_VERSION, 'manual', false);
}
