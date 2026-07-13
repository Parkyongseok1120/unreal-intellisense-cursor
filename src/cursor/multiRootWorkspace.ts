import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { buildUeSettings } from './workspaceSetup';

const WORKSPACE_MARKER = 'ue58rider.multiRootWorkspace';

export interface MultiRootWorkspaceOptions {
  /**
   * These settings must live in the .code-workspace file, not only in the
   * project-root .vscode/settings.json. A C++ file under Source/ or a plugin
   * Source/ folder resolves configuration against that nested workspace root.
   */
  clangdPath?: string;
  applyExplorerFilter?: boolean;
  contentBrowserMode?: import('./explorerFilter').ContentBrowserMode;
}

export function buildMultiRootWorkspaceContent(
  projectName: string,
  pluginNames: string[],
  options: MultiRootWorkspaceOptions = {},
): Record<string, unknown> {
  const folders: Array<{ name: string; path: string }> = [
    { name: `${projectName} (Root)`, path: '.' },
    { name: 'Source', path: 'Source' },
    { name: 'Config', path: 'Config' },
  ];

  for (const pluginName of pluginNames) {
    folders.push({ name: `Plugin: ${pluginName}`, path: path.join('Plugins', pluginName, 'Source') });
  }

  // Workspace settings apply to every folder in a multi-root workspace.
  // This is essential for nested Source roots, which do not inherit the
  // parent project's .vscode/settings.json.
  const settings = buildUeSettings({
    clangdPath: options.clangdPath,
    applyExplorerFilter: options.applyExplorerFilter,
    contentBrowserMode: options.contentBrowserMode,
  });

  return {
    [WORKSPACE_MARKER]: true,
    folders,
    settings,
    extensions: {
      recommendations: ['llvm-vs-code-extensions.vscode-clangd', 'anysphere.cpptools'],
    },
  };
}

export async function ensureMultiRootWorkspace(
  project: UEProject,
  options: MultiRootWorkspaceOptions = {},
  tx?: WorkspaceMutationTransaction,
): Promise<string | undefined> {
  const wsPath = path.join(project.projectRoot, `${project.name}.code-workspace`);
  let existing = '';
  let existingWorkspaceSettings: Record<string, unknown> = {};
  try {
    existing = await fs.promises.readFile(wsPath, 'utf-8');
    const parsed = JSON.parse(existing) as { settings?: Record<string, unknown> };
    existingWorkspaceSettings = parsed.settings ?? {};
  } catch {
    // new or invalid generated workspace; write a clean replacement below
  }

  // The standalone "Generate Multi-Root Workspace" command does not receive
  // a resolved bundled path. Preserve the one already generated for the
  // project/workspace instead of replacing it with an empty clangd.path.
  let projectClangdPath: unknown;
  try {
    const projectSettingsPath = path.join(project.projectRoot, '.vscode', 'settings.json');
    projectClangdPath = (JSON.parse(await fs.promises.readFile(projectSettingsPath, 'utf-8')) as Record<string, unknown>)['clangd.path'];
  } catch {
    // project settings may not exist on first bootstrap
  }
  const effectiveOptions: MultiRootWorkspaceOptions = {
    ...options,
    clangdPath:
      options.clangdPath ??
      (typeof existingWorkspaceSettings['clangd.path'] === 'string'
        ? existingWorkspaceSettings['clangd.path']
        : undefined) ??
      (typeof projectClangdPath === 'string' ? projectClangdPath : undefined),
  };
  const pluginNames: string[] = [];

  // Plugins/Source modules
  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const p of plugins) {
      if (!p.isDirectory()) continue;
      const src = path.join('Plugins', p.name, 'Source');
      if (await dirExists(path.join(project.projectRoot, src))) {
        pluginNames.push(p.name);
      }
    }
  } catch {
    // no plugins
  }

  const content = buildMultiRootWorkspaceContent(project.name, pluginNames, effectiveOptions);

  const newJson = JSON.stringify(content, null, 2) + '\n';
  if (existing === newJson) return undefined;

  await mutateJson(tx, project.projectRoot, wsPath, content);
  return wsPath;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.promises.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
