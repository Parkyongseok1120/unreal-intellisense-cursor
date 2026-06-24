import * as vscode from 'vscode';

export interface ParsedUFunction {
  name: string;
  line: number;
  flags: string[];
  isBlueprintCallable: boolean;
  isBlueprintPure: boolean;
}

const UFUNCTION_RE = /UFUNCTION\s*\(([^)]*)\)/;
const FUNC_DECL_RE = /^\s*(?:virtual\s+)?[\w:<>,\s*&]+\s+(\w+)\s*\(/;

export function parseUFunctions(text: string): ParsedUFunction[] {
  const lines = text.split(/\r?\n/);
  const results: ParsedUFunction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const ufuncMatch = lines[i].match(UFUNCTION_RE);
    if (!ufuncMatch) continue;

    const flags = ufuncMatch[1].split(',').map((f) => f.trim());
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const decl = lines[j].match(FUNC_DECL_RE);
      if (decl && !decl[1].startsWith('operator')) {
        results.push({
          name: decl[1],
          line: j,
          flags,
          isBlueprintCallable: flags.some((f) => f.includes('BlueprintCallable')),
          isBlueprintPure: flags.some((f) => f.includes('BlueprintPure')),
        });
        break;
      }
    }
  }
  return results;
}
