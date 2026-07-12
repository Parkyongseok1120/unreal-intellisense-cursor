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

/** Experimental HLSL — keyword/hover only; no fake #include directory paths (Gate 0). */
export function registerHLSLProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideCompletionItems(document, position) {
          const line = document.lineAt(position.line).text.slice(0, position.character);
          if (!line.includes('#include')) return [];

          return [
            new vscode.CompletionItem('Common.ush', vscode.CompletionItemKind.File),
            new vscode.CompletionItem('SceneTextures.ush', vscode.CompletionItemKind.File),
          ];
        },
      },
      '"',
    ),
    vscode.languages.registerHoverProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideHover(_document, position) {
          return new vscode.Hover('UE shader IntelliSense is experimental. Use engine shader paths via project setup.');
        },
      },
    ),
  );
}
