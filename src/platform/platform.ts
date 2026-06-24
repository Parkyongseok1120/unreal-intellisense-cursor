import * as os from 'os';
import * as path from 'path';

export type HostPlatform = 'win32' | 'linux' | 'darwin';

export function getHostPlatform(): HostPlatform {
  const p = os.platform();
  if (p === 'win32' || p === 'linux' || p === 'darwin') return p;
  return 'win32';
}

export function getDefaultUePlatform(): 'Win64' | 'Linux' | 'Mac' {
  const p = getHostPlatform();
  if (p === 'linux') return 'Linux';
  if (p === 'darwin') return 'Mac';
  return 'Win64';
}

export function resolveEditorBinaryName(): string {
  const p = getHostPlatform();
  if (p === 'darwin') return 'UnrealEditor';
  if (p === 'linux') return 'UnrealEditor';
  return 'UnrealEditor.exe';
}

export function resolveEditorPath(engineRoot: string): string {
  const p = getHostPlatform();
  if (p === 'darwin') {
    return path.join(engineRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor');
  }
  if (p === 'linux') {
    return path.join(engineRoot, 'Engine', 'Binaries', 'Linux', 'UnrealEditor');
  }
  return path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
}

export function resolveUbtPath(engineRoot: string): string {
  const p = getHostPlatform();
  if (p === 'win32') {
    return path.join(engineRoot, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe');
  }
  const batchDir = p === 'darwin' ? 'Mac' : 'Linux';
  return path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', batchDir, 'Build.sh');
}

export function resolveBinariesPlatformDir(): 'Win64' | 'Linux' | 'Mac' {
  const p = getHostPlatform();
  if (p === 'darwin') return 'Mac';
  if (p === 'linux') return 'Linux';
  return 'Win64';
}

export function getSymbolPathSeparator(): string {
  return getHostPlatform() === 'win32' ? ';' : ':';
}

export function getDebuggerType(): 'cppvsdbg' | 'cppdbg' {
  return getHostPlatform() === 'win32' ? 'cppvsdbg' : 'cppdbg';
}

export function getDebuggerMIMode(): string | undefined {
  const p = getHostPlatform();
  if (p === 'linux') return 'lldb';
  if (p === 'darwin') return 'lldb';
  return undefined;
}
