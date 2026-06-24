import type { ParsedBuildDiagnostic } from '../types';

const MSVC_PATTERN =
  /^(?:\s*\d+>)?([^(\s].*?)\((\d+),(\d+)\)\s*:\s+(error|warning)\s+(\w+)\s*:\s*(.+)$/i;

export function parseBuildOutput(output: string): ParsedBuildDiagnostic[] {
  const results: ParsedBuildDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(MSVC_PATTERN);
    if (!m) continue;
    results.push({
      file: m[1].trim(),
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4].toLowerCase() as 'error' | 'warning',
      code: m[5],
      message: m[6].trim(),
    });
  }
  return results;
}
