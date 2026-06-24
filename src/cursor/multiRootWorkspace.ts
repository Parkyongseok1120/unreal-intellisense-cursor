import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';

const WORKSPACE_MARKER = 'ue58rider.multiRootWorkspace';

export async function ensureMultiRootWorkspace(project: UEProject): Promise<string | undefined> {
  const wsPath = path.join(project.projectRoot, `${project.name}.code-workspace`);
  const folders: Array<{ name: string; path: string }> = [
    { name: `${project.name} (Root)`, path: '.' },
    { name: 'Source', path: 'Source' },
    { name: 'Config', path: 'Config' },
  ];

  // Plugins/Source modules
  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const p of plugins) {
      if (!p.isDirectory()) continue;
      const src = path.join('Plugins', p.name, 'Source');
      if (await dirExists(path.join(project.projectRoot, src))) {
        folders.push({ name: `Plugin: ${p.name}`, path: src });
      }
    }
  } catch {
    // no plugins
  }

  const content = {
    [WORKSPACE_MARKER]: true,
    folders,
    settings: {
      'files.exclude': {
        Binaries: true,
        Intermediate: true,
        DerivedDataCache: true,
        Saved: true,
        Content: true,
        Build: true,
        Docs: true,
      },
    },
    extensions: {
      recommendations: ['anysphere.cpptools'],
    },
  };

  const newJson = JSON.stringify(content, null, 2) + '\n';
  let existing = '';
  try {
    existing = await fs.promises.readFile(wsPath, 'utf-8');
  } catch {
    // new
  }
  if (existing === newJson) return undefined;

  await fs.promises.writeFile(wsPath, newJson, 'utf-8');
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
