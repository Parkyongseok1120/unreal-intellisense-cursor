import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawnAsync } from '../platform/process';
import { fileExists } from '../platform/paths';
import { RECOMMENDED_LLVM_VERSION, CLANGD_EXTENSION_ID } from '../constants';
import { getHostPlatform } from '../platform/platform';
import type { PrerequisiteCheck } from '../types';

const LLVM_CANDIDATE_PATHS_WIN = [
  'C:\\Program Files\\LLVM\\bin\\clangd.exe',
  'C:\\Program Files (x86)\\LLVM\\bin\\clangd.exe',
  'C:\\LLVM\\bin\\clangd.exe',
];

const LLVM_CANDIDATE_PATHS_UNIX = [
  '/usr/bin/clangd',
  '/usr/local/bin/clangd',
  '/opt/homebrew/bin/clangd',
];

export function resolveBundledClangdPath(extensionPath?: string): string | undefined {
  if (!extensionPath) return undefined;
  const platform = getHostPlatform() === 'win32' ? 'win32-x64' : getHostPlatform() === 'darwin' ? 'darwin-x64' : 'linux-x64';
  const candidate = path.join(extensionPath, 'bin', platform, 'clangd.exe');
  if (getHostPlatform() !== 'win32') {
    const unixCandidate = path.join(extensionPath, 'bin', platform, 'clangd');
    if (fs.existsSync(unixCandidate)) return unixCandidate;
  }
  if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

/** A complete bundled toolchain is required only for UBT database generation. */
export function resolveClangCompilerPath(clangdPath?: string): string | undefined {
  if (!clangdPath) return undefined;
  const dir = path.dirname(clangdPath);
  for (const name of getHostPlatform() === 'win32' ? ['clang++.exe', 'clang-cl.exe'] : ['clang++', 'clang']) {
    for (const candidate of [path.join(dir, name), path.join(dir, 'bin', name)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function findClangdPath(customPath?: string, extensionPath?: string): Promise<string | undefined> {
  const bundled = resolveBundledClangdPath(extensionPath);
  if (bundled) return bundled;

  if (customPath && (await fileExists(customPath))) return customPath;

  const candidates = getHostPlatform() === 'win32' ? LLVM_CANDIDATE_PATHS_WIN : LLVM_CANDIDATE_PATHS_UNIX;
  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  try {
    const whichCmd = getHostPlatform() === 'win32' ? 'where' : 'which';
    const result = await spawnAsync(whichCmd, ['clangd'], { shell: true });
    if (result.exitCode === 0) {
      const first = result.stdout.split('\n')[0]?.trim();
      if (first) return first;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export async function getClangdVersion(clangdPath: string): Promise<string | undefined> {
  try {
    const result = await spawnAsync(clangdPath, ['--version']);
    const match = result.stdout.match(/version\s+([\d.]+)/i) ?? result.stdout.match(/clangd version\s+([\d.]+)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function checkPrerequisites(llvmCustomPath?: string, extensionPath?: string): Promise<PrerequisiteCheck[]> {
  const checks: PrerequisiteCheck[] = [];

  const clangdPath = await findClangdPath(llvmCustomPath, extensionPath);
  if (!clangdPath) {
    checks.push({
      name: 'LLVM / clangd',
      ok: false,
      detail: 'clangd를 찾을 수 없습니다.',
      fixHint: `LLVM ${RECOMMENDED_LLVM_VERSION} 설치 또는 VSIX 번들 clangd 확인`,
    });
  } else {
    const version = await getClangdVersion(clangdPath);
    const majorOk = version?.startsWith('20') ?? false;
    const bundled = resolveBundledClangdPath(extensionPath);
    checks.push({
      name: 'LLVM / clangd',
      ok: majorOk || !!bundled,
      detail: `${clangdPath} (v${version ?? 'unknown'})${bundled && clangdPath === bundled ? ' [bundled]' : ''}`,
      fixHint: majorOk
        ? undefined
        : `UE 5.8 권장 LLVM ${RECOMMENDED_LLVM_VERSION}. 현재: ${version}`,
    });
    const compiler = resolveClangCompilerPath(clangdPath);
    checks.push({
      name: 'LLVM compiler for UBT database generation',
      ok: !!compiler,
      detail: compiler ?? 'clangd only (RSP fallback remains partial)',
      fixHint: compiler ? undefined : 'Install the full UE5_8 Cursor VSIX toolchain or LLVM Clang x64.',
    });
  }

  try {
    const clangdExt = vscode.extensions.getExtension(CLANGD_EXTENSION_ID);
    checks.push({
      name: 'clangd extension',
      ok: !!clangdExt,
      detail: clangdExt ? `${CLANGD_EXTENSION_ID} installed` : 'vscode-clangd not installed',
      fixHint: clangdExt ? undefined : `Extensions에서 ${CLANGD_EXTENSION_ID} 설치`,
    });
  } catch {
    // extension API unavailable in tests
  }

  try {
    const result = await spawnAsync('reg', ['query', 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\5.8'], {
      shell: true,
    });
    checks.push({
      name: 'UE 5.8 (Registry)',
      ok: result.exitCode === 0,
      detail: result.exitCode === 0 ? '레지스트리에서 UE 5.8 발견' : 'UE 5.8 레지스트리 항목 없음',
      fixHint: result.exitCode === 0 ? undefined : 'Epic Games Launcher에서 UE 5.8 설치',
    });
  } catch {
    checks.push({
      name: 'UE 5.8 (Registry)',
      ok: false,
      detail: '레지스트리 확인 실패',
      fixHint: 'Epic Games Launcher에서 UE 5.8 설치',
    });
  }

  const vsWhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (await fileExists(vsWhere)) {
    const result = await spawnAsync(vsWhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ]);
    checks.push({
      name: 'Visual Studio Build Tools',
      ok: result.exitCode === 0 && result.stdout.trim().length > 0,
      detail: result.stdout.trim() || 'MSVC 빌드 도구 없음',
      fixHint: 'Visual Studio Installer → C++ 데스크톱 개발 + Clang 컴파일러',
    });
  }

  return checks;
}
