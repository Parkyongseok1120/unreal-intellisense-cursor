import * as path from 'path';

export interface ShaderCompileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

const SHADER_DIAG_RE =
  /^(?<file>[A-Za-z]:\\[^\s(]+|\/?[^\s(]+)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<severity>error|warning)\s*:\s*(?<message>.+)$/i;

/** Map ShaderCompileWorker log lines to .usf/.ush diagnostics. */
export function parseShaderCompileWorkerOutput(output: string, projectRoot?: string): ShaderCompileDiagnostic[] {
  const diagnostics: ShaderCompileDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(SHADER_DIAG_RE);
    if (!match?.groups) continue;
    let file = match.groups.file.trim();
    if (projectRoot && file.startsWith('/')) {
      if (file.startsWith('/Engine/')) {
        file = file.replace('/Engine/', 'Engine/');
      } else if (file.startsWith('/Project/')) {
        file = path.join(projectRoot, file.replace('/Project/', ''));
      } else if (file.startsWith('/Plugin/')) {
        file = path.join(projectRoot, 'Plugins', file.replace('/Plugin/', ''));
      }
    }
    diagnostics.push({
      file: path.normalize(file),
      line: Number(match.groups.line),
      column: match.groups.column ? Number(match.groups.column) : 1,
      severity: match.groups.severity.toLowerCase() as 'error' | 'warning',
      message: match.groups.message.trim(),
    });
  }
  return diagnostics;
}

export function virtualShaderIncludeRoots(projectRoot: string, engineRoot?: string): Record<string, string> {
  const roots: Record<string, string> = {
    '/Project': path.join(projectRoot, 'Shaders'),
    '/Plugin': path.join(projectRoot, 'Plugins'),
  };
  if (engineRoot) roots['/Engine'] = path.join(engineRoot, 'Engine', 'Shaders');
  return roots;
}

export function resolveVirtualShaderInclude(
  includePath: string,
  projectRoot: string,
  engineRoot?: string,
): string | undefined {
  const roots = virtualShaderIncludeRoots(projectRoot, engineRoot);
  for (const [virtual, disk] of Object.entries(roots)) {
    if (includePath.startsWith(virtual)) {
      return path.join(disk, includePath.slice(virtual.length).replace(/^[/\\]/, ''));
    }
  }
  return undefined;
}
