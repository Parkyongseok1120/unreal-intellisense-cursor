import * as fs from 'fs';
import * as path from 'path';
import { spawnAsync } from './process';
import { fileExists } from './paths';
import {
  getHostPlatform,
  resolveBinariesPlatformDir,
  getSymbolPathSeparator,
  resolveEditorPath,
} from './platform';
import { resolveGameTargetName } from '../build/targetResolver';
import type { BuildConfiguration, BuildPlatform, UEInstallation, UEProject } from '../types';

export interface EditorProcess {
  pid: number;
  name: string;
  commandLine?: string;
}

export function normalizePathForProcessMatch(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

export function editorProcessMatchesProject(process: EditorProcess, uprojectPath: string): boolean {
  const commandLine = process.commandLine;
  if (!commandLine) return false;

  const normalizedLine = normalizePathForProcessMatch(commandLine);
  const normalizedProject = normalizePathForProcessMatch(uprojectPath);
  if (normalizedLine.includes(normalizedProject)) return true;

  const projectFile = path.basename(normalizedProject);
  return (
    normalizedLine.includes(projectFile) &&
    (normalizedLine.includes('-project') || normalizedLine.includes(`"${projectFile}`) || normalizedLine.endsWith(projectFile))
  );
}

export function filterEditorProcessesByProject(
  processes: EditorProcess[],
  uprojectPath: string,
): EditorProcess[] {
  const withCommandLine = processes.filter((process) => process.commandLine);
  if (withCommandLine.length === 0) return processes;

  const matched = withCommandLine.filter((process) => editorProcessMatchesProject(process, uprojectPath));
  return matched;
}

const NATVIS_RELATIVE = path.join('Engine', 'Extras', 'VisualStudioDebugging', 'Unreal.natvis');

export function resolveNatvisPath(engineRoot: string): string {
  return path.join(engineRoot, NATVIS_RELATIVE);
}

export async function natvisExists(engineRoot: string): Promise<boolean> {
  return fileExists(resolveNatvisPath(engineRoot));
}

export function resolveServerExecutable(project: UEProject): string {
  const platDir = resolveBinariesPlatformDir();
  const ext = getHostPlatform() === 'win32' ? '.exe' : '';
  return path.join(project.projectRoot, 'Binaries', platDir, `${project.name}Server${ext}`);
}

export function resolveEditorProgramPath(
  engineRoot: string,
  configuration: BuildConfiguration = 'Development',
  platform: BuildPlatform = 'Win64',
  options?: { allowDevelopmentFallback?: boolean },
): string {
  const host = getHostPlatform();
  const platDir = resolveBinariesPlatformDir();
  const binDir = path.join(engineRoot, 'Engine', 'Binaries', platDir);

  if (host === 'win32' && configuration !== 'Development' && configuration !== 'Shipping') {
    const candidate = path.join(binDir, `UnrealEditor-${platform}-${configuration}.exe`);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
    if (options?.allowDevelopmentFallback === false) {
      throw new Error(`DebugGame binary not found: ${candidate}. Build DebugGame first.`);
    }
  }

  return resolveEditorPath(engineRoot);
}

export function resolveGameExecutable(
  project: UEProject,
  configuration: BuildConfiguration = 'Development',
  platform: BuildPlatform = 'Win64',
  options?: { allowDevelopmentFallback?: boolean },
): string {
  const platDir = resolveBinariesPlatformDir();
  const ext = getHostPlatform() === 'win32' ? '.exe' : '';
  const binDir = path.join(project.projectRoot, 'Binaries', platDir);
  const gameName = resolveGameTargetName(project);
  if (getHostPlatform() === 'win32' && configuration !== 'Development' && configuration !== 'Shipping') {
    const candidate = path.join(binDir, `${gameName}-${platform}-${configuration}${ext}`);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
    if (options?.allowDevelopmentFallback === false) {
      throw new Error(`DebugGame game binary not found: ${candidate}. Build DebugGame first.`);
    }
  }
  return path.join(binDir, `${gameName}${ext}`);
}

export function buildSymbolSearchPaths(project: UEProject, engine: UEInstallation): string {
  const platDir = resolveBinariesPlatformDir();
  const sep = getSymbolPathSeparator();
  const paths = [
    path.join(project.projectRoot, 'Binaries', platDir),
    path.join(engine.root, 'Engine', 'Binaries', platDir),
  ];
  const pluginsDir = path.join(project.projectRoot, 'Plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginBin = path.join(pluginsDir, entry.name, 'Binaries', platDir);
      if (fs.existsSync(pluginBin)) paths.push(pluginBin);
    }
  }
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
    const command = [
      "Get-CimInstance Win32_Process -Filter \"Name = 'UnrealEditor.exe'\"",
      'Select-Object ProcessId, CommandLine',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    const result = await spawnAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { shell: false },
    );
    if (result.exitCode !== 0) return [];

    const records = parseJsonArray<{
      ProcessId?: number;
      CommandLine?: string;
    }>(result.stdout);

    return records
      .map((record) => ({
        pid: Number(record.ProcessId ?? 0),
        name: 'UnrealEditor.exe',
        commandLine: record.CommandLine,
      }))
      .filter((process) => process.pid > 0);
  } catch {
    return [];
  }
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw.trim()) return [];
  try {
    const value = JSON.parse(raw) as T | T[];
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

async function findUnixEditorProcesses(name: string): Promise<EditorProcess[]> {
  try {
    const result = await spawnAsync('ps', ['-axo', 'pid=,comm=,args=']);
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
      if (!match || !new RegExp(name, 'i').test(match[2])) return [];
      return [{
        pid: Number(match[1]),
        name: match[2],
        commandLine: match[3]?.trim() || undefined,
      }];
    });
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
