import * as vscode from 'vscode';

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

export function registerHLSLProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideCompletionItems() {
          return [
            new vscode.CompletionItem('float4', vscode.CompletionItemKind.Keyword),
            new vscode.CompletionItem('Texture2D', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('SamplerState', vscode.CompletionItemKind.Class),
          ];
        },
      },
      '.',
    ),
  );
}
