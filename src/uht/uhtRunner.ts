import * as fs from 'fs';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import { spawnAsync } from '../platform/process';
import type { UEInstallation, UEProject } from '../types';

export interface UhtDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  code?: string;
}

export interface UhtRunResult {
  ok: boolean;
  diagnostics: UhtDiagnostic[];
  allDiagnostics?: UhtDiagnostic[];
  stdout: string;
  stderr: string;
  cacheKey?: string;
  manifestPath?: string;
}

const UHT_DIAG_RE =
  /^(?<file>.+?)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<severity>error|warning)\s*(?<code>[A-Z]+\d+)?\s*:\s*(?<message>.+)$/i;

export function parseUhtOutput(output: string): UhtDiagnostic[] {
  const diagnostics: UhtDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(UHT_DIAG_RE);
    if (!match?.groups) continue;
    diagnostics.push({
      file: match.groups.file.trim(),
      line: Number(match.groups.line),
      column: match.groups.column ? Number(match.groups.column) : 1,
      severity: match.groups.severity.toLowerCase() as 'error' | 'warning',
      code: match.groups.code,
      message: match.groups.message.trim(),
    });
  }
  return diagnostics;
}

export function resolveUhtExecutable(engine: UEInstallation): string {
  const win = path.join(engine.root, 'Engine', 'Binaries', 'Win64', 'UnrealHeaderTool.exe');
  return win;
}

export async function parseUhtManifestInputFiles(manifestPath: string): Promise<string[]> {
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const json = JSON.parse(raw) as {
      Modules?: Array<{ InputFiles?: string[] }>;
    };
    const files: string[] = [];
    for (const mod of json.Modules ?? []) {
      for (const f of mod.InputFiles ?? []) {
        files.push(path.normalize(f));
      }
    }
    return files;
  } catch {
    return [];
  }
}

export async function findUhtManifest(project: UEProject): Promise<string | undefined> {
  const base = path.join(project.projectRoot, 'Intermediate', 'Build', 'Win64');
  const manifestName = `${project.name}Editor.uhtmanifest`;
  const candidates = [
    path.join(base, `${project.name}Editor`, 'Development', manifestName),
    path.join(base, 'UnrealEditor', 'Development', manifestName),
    path.join(base, 'x64', `${project.name}Editor`, 'Development', manifestName),
    path.join(base, 'x64', 'UnrealEditor', 'Development', manifestName),
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return findFileBelow(base, manifestName, 5);
}

async function findFileBelow(dir: string, fileName: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileBelow(path.join(dir, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

export async function buildUhtCacheKey(project: UEProject, manifestPath?: string): Promise<string> {
  const manifest = manifestPath ?? (await findUhtManifest(project));
  if (!manifest) return `${project.projectRoot.toLowerCase()}:no-manifest`;
  try {
    const stat = await fs.promises.stat(manifest);
    return `${path.normalize(manifest).toLowerCase()}:${stat.mtimeMs}`;
  } catch {
    return `${path.normalize(manifest).toLowerCase()}:missing`;
  }
}

export async function runUhtOnHeader(
  project: UEProject,
  engine: UEInstallation,
  headerPath: string,
  token?: CancellationToken,
): Promise<UhtRunResult> {
  const uht = resolveUhtExecutable(engine);
  if (!(await fileExists(uht))) {
    return { ok: false, diagnostics: [], stdout: '', stderr: `UHT not found: ${uht}` };
  }

  const manifest = await findUhtManifest(project);
  const args = [project.uprojectPath];
  if (manifest) args.push(manifest);
  args.push('-WarningsAsErrors', '-installed');

  if (!manifest) {
    return {
      ok: false,
      diagnostics: [],
      stdout: '',
      stderr: 'UHT manifest missing — run an Editor build first.',
    };
  }

  const result = await spawnAsync(uht, args, { cwd: engine.root, token });
  if (token?.isCancellationRequested) {
    return { ok: false, diagnostics: [], stdout: '', stderr: 'cancelled', cacheKey: await buildUhtCacheKey(project, manifest), manifestPath: manifest };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  const allDiagnostics = parseUhtOutput(combined);
  const diagnostics = allDiagnostics.filter((d) => path.normalize(d.file) === path.normalize(headerPath));
  return {
    ok: result.exitCode === 0,
    diagnostics,
    stdout: result.stdout,
    stderr: result.stderr,
    cacheKey: await buildUhtCacheKey(project, manifest),
    manifestPath: manifest,
    allDiagnostics,
  };
}

export function suggestedQuickFixes(diagnostic: UhtDiagnostic): string[] {
  const fixes: string[] = [];
  if (/GENERATED_BODY/i.test(diagnostic.message)) {
    fixes.push('Verify GENERATED_BODY() placement');
  }
  if (/UFUNCTION/i.test(diagnostic.message)) {
    fixes.push('Add missing UFUNCTION() macro');
  }
  return fixes;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}
