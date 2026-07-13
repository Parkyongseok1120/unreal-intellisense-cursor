import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_DATA_DIR } from '../constants';
import { mutateJson } from '../platform/workspaceMutation';
import {
  createDiagnosticBaseline,
  type DiagnosticBaseline,
  type DiagnosticInput,
} from './diagnosticBaseline';
import type { UbtBuildEvidence } from './ubtBuildEvidence';

function severityName(severity: vscode.DiagnosticSeverity): DiagnosticInput['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'information';
    default: return 'hint';
  }
}

function diagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
  if (typeof diagnostic.code === 'string') return diagnostic.code;
  if (diagnostic.code && typeof diagnostic.code === 'object') return String(diagnostic.code.value);
  return undefined;
}

function isRelevant(uri: vscode.Uri, projectRoot: string, engineRoot?: string): boolean {
  if (uri.scheme !== 'file') return false;
  const file = path.resolve(uri.fsPath).toLowerCase();
  const roots = [projectRoot, engineRoot].filter((root): root is string => !!root);
  return roots.some((root) => {
    const normalized = path.resolve(root).toLowerCase();
    return file === normalized || file.startsWith(`${normalized}${path.sep}`);
  });
}

export function collectWorkspaceDiagnostics(projectRoot: string, engineRoot?: string): DiagnosticInput[] {
  const inputs: DiagnosticInput[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (!isRelevant(uri, projectRoot, engineRoot)) continue;
    for (const diagnostic of diagnostics) {
      inputs.push({
        filePath: uri.fsPath,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity: severityName(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnosticCode(diagnostic),
      });
    }
  }
  return inputs;
}

export async function captureDiagnosticBaseline(
  projectRoot: string,
  options: { engineRoot?: string; capturedAt?: string; ubtBuild?: UbtBuildEvidence } = {},
): Promise<{ baseline: DiagnosticBaseline; filePath: string }> {
  const baseline = createDiagnosticBaseline(
    collectWorkspaceDiagnostics(projectRoot, options.engineRoot),
    { projectRoot, engineRoot: options.engineRoot, capturedAt: options.capturedAt, ubtBuild: options.ubtBuild },
  );
  const safeTimestamp = baseline.capturedAt.replace(/[:.]/g, '-');
  const filePath = path.join(projectRoot, EXTENSION_DATA_DIR, 'metrics', `diagnostics-${safeTimestamp}.json`);
  await mutateJson(undefined, projectRoot, filePath, baseline);
  return { baseline, filePath };
}
