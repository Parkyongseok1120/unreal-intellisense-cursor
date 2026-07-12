import * as vscode from 'vscode';
import * as path from 'path';
import type { UEProject, UEInstallation } from '../types';
import { ProjectSession } from './projectSession';
import { EditorBridgeClient } from '../editorBridge/editorBridgeClient';

export interface ProjectRuntime {
  project: UEProject;
  engine?: UEInstallation;
  session: ProjectSession;
  editorBridge: EditorBridgeClient;
}

export class WorkspaceProjectRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private activeRoot: string | undefined;

  getByRoot(projectRoot: string): ProjectRuntime | undefined {
    return this.runtimes.get(this.canonical(projectRoot));
  }

  getByUri(uri: vscode.Uri): ProjectRuntime | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return this.getActive();
    for (const runtime of this.runtimes.values()) {
      const root = path.normalize(runtime.project.projectRoot);
      if (uri.fsPath.startsWith(root)) return runtime;
    }
    return undefined;
  }

  getActive(): ProjectRuntime | undefined {
    if (this.activeRoot) return this.runtimes.get(this.activeRoot);
    const values = [...this.runtimes.values()];
    return values.length === 1 ? values[0] : undefined;
  }

  setActive(projectRoot: string): void {
    this.activeRoot = this.canonical(projectRoot);
  }

  ensure(
    project: UEProject,
    engine: UEInstallation | undefined,
    bridgeContext?: vscode.ExtensionContext,
  ): ProjectRuntime {
    const key = this.canonical(project.projectRoot);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = {
        project,
        engine,
        session: new ProjectSession(),
        editorBridge: new EditorBridgeClient(project.projectRoot, bridgeContext),
      };
      this.runtimes.set(key, runtime);
    } else {
      runtime.project = project;
      runtime.engine = engine;
    }
    this.activeRoot = key;
    return runtime;
  }

  disposeProject(projectRoot: string): void {
    const key = this.canonical(projectRoot);
    const runtime = this.runtimes.get(key);
    runtime?.session.dispose();
    runtime?.editorBridge.dispose();
    this.runtimes.delete(key);
    if (this.activeRoot === key) this.activeRoot = undefined;
  }

  disposeAll(): void {
    for (const key of [...this.runtimes.keys()]) {
      this.disposeProject(key);
    }
  }

  listRoots(): string[] {
    return [...this.runtimes.keys()];
  }

  private canonical(projectRoot: string): string {
    return path.resolve(projectRoot).toLowerCase();
  }
}

let globalRegistry: WorkspaceProjectRegistry | undefined;

export function getWorkspaceProjectRegistry(): WorkspaceProjectRegistry {
  if (!globalRegistry) globalRegistry = new WorkspaceProjectRegistry();
  return globalRegistry;
}

export function disposeWorkspaceProjectRegistry(): void {
  globalRegistry?.disposeAll();
  globalRegistry = undefined;
}
