import * as path from 'path';
import { spawnAsync } from './process';
import { fileExists } from './paths';
import { getHostPlatform, resolveBinariesPlatformDir, getSymbolPathSeparator } from './platform';
import type { UEInstallation, UEProject } from '../types';

export interface EditorProcess {
  pid: number;
  name: string;
}

const NATVIS_RELATIVE = path.join('Engine', 'Extras', 'VisualStudioDebugging', 'Unreal.natvis');

export function resolveNatvisPath(engineRoot: string): string {
  return path.join(engineRoot, NATVIS_RELATIVE);
}

export async function natvisExists(engineRoot: string): Promise<boolean> {
  return fileExists(resolveNatvisPath(engineRoot));
}

export function resolveGameExecutable(project: UEProject): string {
  const platDir = resolveBinariesPlatformDir();
  const ext = getHostPlatform() === 'win32' ? '.exe' : '';
  return path.join(project.projectRoot, 'Binaries', platDir, `${project.name}${ext}`);
}

export function buildSymbolSearchPaths(project: UEProject, engine: UEInstallation): string {
  const platDir = resolveBinariesPlatformDir();
  const sep = getSymbolPathSeparator();
  const paths = [
    path.join(project.projectRoot, 'Binaries', platDir),
    path.join(engine.root, 'Engine', 'Binaries', platDir),
    path.join(project.projectRoot, 'Plugins'),
  ];
  return paths.join(sep);
}

/** 실행 중인 UnrealEditor 프로세스 탐색 */
export async function findUnrealEditorProcesses(): Promise<EditorProcess[]> {
  const host = getHostPlatform();
  if (host === 'win32') return findWindowsEditorProcesses();
  if (host === 'darwin') return findUnixEditorProcesses('UnrealEditor');
  return findUnixEditorProcesses('UnrealEditor');
}

async function findWindowsEditorProcesses(): Promise<EditorProcess[]> {
  try {
    const result = await spawnAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name 'UnrealEditor' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ],
      { shell: false },
    );
    if (result.exitCode !== 0) return [];

    const pids = result.stdout
      .split(/\r?\n/)
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    return pids.map((pid) => ({ pid, name: 'UnrealEditor.exe' }));
  } catch {
    return [];
  }
}

async function findUnixEditorProcesses(name: string): Promise<EditorProcess[]> {
  try {
    const result = await spawnAsync('pgrep', ['-f', name], { shell: false });
    if (result.exitCode !== 0) return [];
    const pids = result.stdout
      .split(/\r?\n/)
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    return pids.map((pid) => ({ pid, name }));
  } catch {
    return [];
  }
}

export function baseCppDebuggerOptions(engine: UEInstallation, project: UEProject) {
  const natvis = resolveNatvisPath(engine.root);
  const common = {
    visualizerFile: natvis,
    requireExactSource: false,
    symbolSearchPath: buildSymbolSearchPaths(project, engine),
    logging: { moduleLoad: false, trace: false },
  };

  if (getHostPlatform() === 'win32') {
    return { type: 'cppvsdbg' as const, ...common };
  }

  return {
    type: 'cppdbg' as const,
    MIMode: getHostPlatform() === 'darwin' ? 'lldb' : 'lldb',
    ...common,
  };
}

/** @deprecated use baseCppDebuggerOptions */
export function baseCppVsdbgOptions(engine: UEInstallation, project: UEProject) {
  return baseCppDebuggerOptions(engine, project);
}
