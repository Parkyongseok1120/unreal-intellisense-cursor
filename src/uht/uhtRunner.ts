import * as fs from 'fs';
import * as path from 'path';
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

const UHT_DIAG_RE = /^(?<file>.+?)\((?<line>\d+)\)\s*:\s*(?<severity>error|warning)\s*(?<code>[A-Z]+\d+)?\s*:\s*(?<message>.+)$/i;

export function parseUhtOutput(output: string): UhtDiagnostic[] {
  const diagnostics: UhtDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(UHT_DIAG_RE);
    if (!match?.groups) continue;
    diagnostics.push({
      file: match.groups.file.trim(),
      line: Number(match.groups.line),
      column: 1,
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

export async function runUhtOnHeader(
  project: UEProject,
  engine: UEInstallation,
  headerPath: string,
): Promise<UhtRunResult> {
  const uht = resolveUhtExecutable(engine);
  if (!(await fileExists(uht))) {
    return { ok: false, diagnostics: [], stdout: '', stderr: `UHT not found: ${uht}` };
  }

  const args = [
    project.uprojectPath,
    path.join(project.projectRoot, 'Intermediate', 'Build', 'Win64', `${project.name}Editor`, 'Development', `${project.name}Editor.uhtmanifest`),
    '-WarningsAsErrors',
    '-installed',
  ];

  // UHT expects manifest from a prior build; if missing, return advisory failure.
  if (!(await fileExists(args[1]))) {
    return {
      ok: false,
      diagnostics: [],
      stdout: '',
      stderr: 'UHT manifest missing — run an Editor build first.',
    };
  }

  const result = await spawnAsync(uht, args, { cwd: engine.root });
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
  if (/RPC.+_Implementation/i.test(diagnostic.message)) {
    fixes.push('Generate _Implementation stub');
  }
  if (/BlueprintNativeEvent/i.test(diagnostic.message)) {
    fixes.push('Generate _Implementation for BlueprintNativeEvent');
  }
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
