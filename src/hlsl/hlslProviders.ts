import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface StructuredLogEntry {
  timestamp: string;
  category: string;
  verbosity: string;
  message: string;
  source?: string;
}

const LOG_LINE_RE =
  /^\[(?<time>[\d:.]+)\]\[(?<frame>[^\]]*)\]\[(?<category>[^\]]+)\](?<verbosity>Verbose|VeryVerbose|Log|Display|Warning|Error|Fatal)?:\s*(?<message>.*)$/;

export function parseUnrealLogLine(line: string): StructuredLogEntry | undefined {
  const match = line.match(LOG_LINE_RE);
  if (!match?.groups) return undefined;
  return {
    timestamp: match.groups.time,
    category: match.groups.category,
    verbosity: match.groups.verbosity ?? 'Log',
    message: match.groups.message,
  };
}

export function toDiagnostic(entry: StructuredLogEntry, line: number): vscode.Diagnostic {
  const range = new vscode.Range(line, 0, line, entry.message.length);
  const severity =
    entry.verbosity === 'Error' || entry.verbosity === 'Fatal'
      ? vscode.DiagnosticSeverity.Error
      : entry.verbosity === 'Warning'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
  const diag = new vscode.Diagnostic(range, `[${entry.category}] ${entry.message}`, severity);
  diag.source = 'UnrealLog';
  diag.code = entry.verbosity;
  return diag;
}

function discoverShaderIncludes(workspaceRoot?: string, engineRoot?: string): string[] {
  const names = new Set<string>();
  const roots = [
    engineRoot ? path.join(engineRoot, 'Engine', 'Shaders') : undefined,
    workspaceRoot ? path.join(workspaceRoot, 'Shaders') : undefined,
  ].filter((r): r is string => !!r);

  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && /\.(ush|usf|hlsl)$/i.test(entry.name)) names.add(entry.name);
      }
    } catch {
      // optional roots
    }
  }
  return [...names].sort().slice(0, 200);
}

/** Experimental HLSL — UE overlay on external language server; include completion from discovered paths. */
export function registerHLSLProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideCompletionItems(document, position) {
          const line = document.lineAt(position.line).text.slice(0, position.character);
          if (!line.includes('#include')) return [];

          const folder = vscode.workspace.getWorkspaceFolder(document.uri);
          const engineRoot = vscode.workspace.getConfiguration('ue58rider').get<string>('engineRoot');
          const includes = discoverShaderIncludes(folder?.uri.fsPath, engineRoot);
          return includes.map(
            (name) => new vscode.CompletionItem(name, vscode.CompletionItemKind.File),
          );
        },
      },
      '"',
    ),
    vscode.languages.registerHoverProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideHover() {
          return new vscode.Hover(
            'UE shader overlay: pair with a HLSL language server extension for diagnostics and go-to-definition.',
          );
        },
      },
    ),
  );
}
