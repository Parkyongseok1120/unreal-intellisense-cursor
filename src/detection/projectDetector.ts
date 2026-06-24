import * as vscode from 'vscode';
import * as path from 'path';
import { parseUProject, isUE58Association } from '../parsers/uprojectParser';
import type { UEProject } from '../types';

export async function detectProjects(): Promise<UEProject[]> {
  const uris = await vscode.workspace.findFiles('**/*.uproject', '**/Intermediate/**', 20);
  const projects: UEProject[] = [];

  for (const uri of uris) {
    try {
      const data = await parseUProject(uri.fsPath);
      if (!isUE58Association(data.engineAssociation)) {
        continue;
      }
      projects.push({
        name: path.basename(uri.fsPath, '.uproject'),
        uprojectPath: uri.fsPath,
        projectRoot: path.dirname(uri.fsPath),
        engineAssociation: data.engineAssociation,
        modules: data.modules,
      });
    } catch {
      // skip invalid
    }
  }

  return projects;
}

/** Prefer workspace-root .uproject; otherwise auto-pick a lone subfolder project (e.g. Github/ → Project_MJS/). */
export async function resolvePrimaryProject(projects: UEProject[]): Promise<UEProject | undefined> {
  if (projects.length === 0) return undefined;
  if (projects.length === 1) return projects[0];

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const normalizedRoot = path.normalize(workspaceRoot);
    const atRoot = projects.filter((p) => path.normalize(path.dirname(p.uprojectPath)) === normalizedRoot);
    if (atRoot.length === 1) return atRoot[0];
    if (atRoot.length > 1) return selectProject(atRoot);

    const subfolderOnly = projects.filter((p) => path.normalize(p.projectRoot) !== normalizedRoot);
    if (subfolderOnly.length === 1) return subfolderOnly[0];
  }

  return selectProject(projects);
}

export async function selectProject(projects: UEProject[]): Promise<UEProject | undefined> {
  if (projects.length === 0) return undefined;
  if (projects.length === 1) return projects[0];

  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.uprojectPath, project: p })),
    { placeHolder: 'UE 5.8 프로젝트 선택' },
  );
  return picked?.project;
}

export function watchForProjectChanges(callback: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.uproject');
  return vscode.Disposable.from(
    watcher.onDidCreate(callback),
    watcher.onDidDelete(callback),
    watcher,
  );
}
