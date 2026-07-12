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

const ENGINE_SHADER_PATHS = [
  'Engine/Shaders',
  'Engine/Shaders/Private',
  'Engine/Shaders/Public',
];

export function registerHLSLProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideCompletionItems(document) {
          const items: vscode.CompletionItem[] = [
            new vscode.CompletionItem('float4', vscode.CompletionItemKind.Keyword),
            new vscode.CompletionItem('Texture2D', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('SamplerState', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('StructuredBuffer', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('RWTexture2D', vscode.CompletionItemKind.Class),
          ];

          const engineRoot = resolveEngineRootFromDocument(document);
          if (engineRoot) {
            for (const rel of ENGINE_SHADER_PATHS) {
              const include = path.join(engineRoot, rel).replace(/\\/g, '/');
              const item = new vscode.CompletionItem(include, vscode.CompletionItemKind.Folder);
              item.detail = 'UE engine shader include path';
              items.push(item);
            }
          }

          return items;
        },
      },
      '.',
      '/',
    ),
    vscode.languages.registerHoverProvider(
      { language: 'hlsl', scheme: 'file' },
      {
        provideHover(document, position) {
          const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
          if (!wordRange) return undefined;
          const word = document.getText(wordRange);
          if (word === 'Texture2D' || word === 'SamplerState') {
            return new vscode.Hover(`UE HLSL type \`${word}\` — requires engine shader include paths for DXC/FXC parity.`);
          }
          return undefined;
        },
      },
    ),
  );
}

function resolveEngineRootFromDocument(document: vscode.TextDocument): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;

  for (const folder of folders) {
    const engineDir = path.join(folder.uri.fsPath, 'Engine');
    if (fs.existsSync(path.join(engineDir, 'Shaders'))) {
      return folder.uri.fsPath;
    }
  }

  const cfg = vscode.workspace.getConfiguration('ue58rider');
  const engineRoot = cfg.get<string>('engineRoot');
  if (engineRoot && fs.existsSync(path.join(engineRoot, 'Engine', 'Shaders'))) {
    return engineRoot;
  }

  return undefined;
}
