import * as fs from 'fs';
import * as path from 'path';
import type { UProjectData } from '../types';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

export interface UProjectPluginEntry {
  Name: string;
  Enabled: boolean;
  [key: string]: unknown;
}

export interface UProjectFullData extends UProjectData {
  Plugins?: UProjectPluginEntry[];
}

export const REQUIRED_MCP_PLUGINS = ['ModelContextProtocol', 'AllToolsets'] as const;

export async function parseUProject(uprojectPath: string): Promise<UProjectData> {
  const data = await parseUProjectFull(uprojectPath);
  return {
    fileVersion: data.fileVersion ?? 3,
    engineAssociation: data.engineAssociation ?? '',
    modules: data.modules ?? [],
  };
}

export async function parseUProjectFull(uprojectPath: string): Promise<UProjectFullData> {
  const raw = await fs.promises.readFile(uprojectPath, 'utf-8');
  const data = JSON.parse(raw) as UProjectFullData & {
    FileVersion?: number;
    EngineAssociation?: string;
    Modules?: UProjectFullData['modules'];
  };
  return {
    ...data,
    fileVersion: data.FileVersion ?? data.fileVersion ?? 3,
    engineAssociation: data.EngineAssociation ?? data.engineAssociation ?? '',
    modules: data.Modules ?? data.modules ?? [],
    Plugins: data.Plugins ?? [],
  };
}

export function isUE58Association(association: string): boolean {
  if (!association) return false;
  if (association.startsWith('{')) return true;
  return association.startsWith('5.8');
}

export function getPluginStatus(plugins: UProjectPluginEntry[], name: string): boolean | undefined {
  const entry = plugins.find((p) => p.Name === name);
  return entry?.Enabled;
}

export function getMissingMcpPlugins(plugins: UProjectPluginEntry[]): string[] {
  return REQUIRED_MCP_PLUGINS.filter((name) => getPluginStatus(plugins, name) !== true);
}

export async function ensureMcpPluginsInUProject(
  uprojectPath: string,
  tx?: WorkspaceMutationTransaction,
): Promise<boolean> {
  const raw = await fs.promises.readFile(uprojectPath, 'utf-8');
  const data = JSON.parse(raw) as { Plugins?: UProjectPluginEntry[] };
  const plugins = [...(data.Plugins ?? [])];
  let changed = false;

  for (const name of REQUIRED_MCP_PLUGINS) {
    const idx = plugins.findIndex((p) => p.Name === name);
    if (idx === -1) {
      plugins.push({ Name: name, Enabled: true });
      changed = true;
    } else if (!plugins[idx].Enabled) {
      plugins[idx] = { ...plugins[idx], Enabled: true };
      changed = true;
    }
  }

  if (!changed) return false;

  const updated = { ...data, Plugins: plugins };
  const projectRoot = path.dirname(uprojectPath);
  await mutateJson(tx, projectRoot, uprojectPath, updated, { consentGranted: true });
  return true;
}

export async function ensurePluginInUProject(
  uprojectPath: string,
  pluginName: string,
  tx?: WorkspaceMutationTransaction,
  opts?: { consentGranted?: boolean },
): Promise<boolean> {
  const raw = await fs.promises.readFile(uprojectPath, 'utf-8');
  const data = JSON.parse(raw) as { Plugins?: UProjectPluginEntry[] };
  const plugins = [...(data.Plugins ?? [])];
  const idx = plugins.findIndex((p) => p.Name === pluginName);

  if (idx === -1) {
    plugins.push({ Name: pluginName, Enabled: true });
  } else if (plugins[idx].Enabled) {
    return false;
  } else {
    plugins[idx] = { ...plugins[idx], Enabled: true };
  }

  const updated = { ...data, Plugins: plugins };
  const projectRoot = path.dirname(uprojectPath);
  await mutateJson(tx, projectRoot, uprojectPath, updated, { consentGranted: opts?.consentGranted });
  return true;
}
