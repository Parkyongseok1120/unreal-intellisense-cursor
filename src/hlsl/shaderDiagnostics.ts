import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UEProject } from '../types';
import { parseShaderCompileWorkerOutput } from './shaderCompileWorker';

const SHADER_LOG_PREFIX = 'ShaderCompileWorker-';

export async function collectShaderCompileDiagnostics(project: UEProject): Promise<Map<string, vscode.Diagnostic[]>> {
  const logsDir = path.join(project.projectRoot, 'Saved', 'Logs');
  const grouped = new Map<string, vscode.Diagnostic[]>();

  let logFiles: string[] = [];
  try {
    const entries = await fs.promises.readdir(logsDir);
    logFiles = entries
      .filter((name) => name.startsWith(SHADER_LOG_PREFIX) && name.endsWith('.log'))
      .map((name) => path.join(logsDir, name));
  } catch {
    return grouped;
  }

  for (const logFile of logFiles.slice(-3)) {
    try {
      const content = await fs.promises.readFile(logFile, 'utf-8');
      for (const diag of parseShaderCompileWorkerOutput(content, project.projectRoot)) {
        if (!fs.existsSync(diag.file)) continue;
        const key = path.normalize(diag.file).toLowerCase();
        const line = Math.max(0, diag.line - 1);
        const column = Math.max(0, diag.column - 1);
        const range = new vscode.Range(line, column, line, column + 1);
        const list = grouped.get(key) ?? [];
        list.push(
          new vscode.Diagnostic(
            range,
            diag.message,
            diag.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
          ),
        );
        grouped.set(key, list);
      }
    } catch {
      // skip unreadable log
    }
  }

  return grouped;
}

export function registerShaderDiagnostics(
  context: vscode.ExtensionContext,
  getProject: () => UEProject | undefined,
  collection: vscode.DiagnosticCollection,
): void {
  let lastFileKeys: string[] = [];

  const refresh = async () => {
    const project = getProject();
    if (!project) {
      for (const key of lastFileKeys) collection.delete(vscode.Uri.file(key));
      lastFileKeys = [];
      return;
    }
    const grouped = await collectShaderCompileDiagnostics(project);
    for (const key of lastFileKeys) {
      if (!grouped.has(key)) collection.delete(vscode.Uri.file(key));
    }
    lastFileKeys = [...grouped.keys()];
    for (const [fileKey, diags] of grouped) {
      collection.set(vscode.Uri.file(fileKey), diags);
    }
  };

  const timer = setInterval(() => void refresh(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();
}
