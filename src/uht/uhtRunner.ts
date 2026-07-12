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
  stdout: string;
  stderr: string;
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
  const candidates = [
    path.join(base, `${project.name}Editor`, 'Development', `${project.name}Editor.uhtmanifest`),
    path.join(base, 'UnrealEditor', 'Development', `${project.name}Editor.uhtmanifest`),
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(base, entry.name, 'Development', `${project.name}Editor.uhtmanifest`);
      if (await fileExists(manifest)) return manifest;
    }
  } catch {
    // no intermediate
  }
  return undefined;
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
  const combined = `${result.stdout}\n${result.stderr}`;
  const diagnostics = parseUhtOutput(combined).filter((d) => path.normalize(d.file) === path.normalize(headerPath));
  return {
    ok: result.exitCode === 0,
    diagnostics,
    stdout: result.stdout,
    stderr: result.stderr,
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
