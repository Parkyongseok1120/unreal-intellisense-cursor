import * as vscode from 'vscode';

export type InspectionSeverity = 'error' | 'warning' | 'information';

export interface UeInspection {
  id: string;
  message: string;
  severity: InspectionSeverity;
  line: number;
  column: number;
  length: number;
}

export interface UeInspectionResult {
  inspections: UeInspection[];
  fingerprint: string;
}

type FileRule = {
  id: string;
  severity: InspectionSeverity;
  enabled: boolean;
  run: (content: string) => UeInspection[];
};

function collectUfunctionBlocks(content: string): Array<{ text: string; line: number }> {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ text: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/UFUNCTION\s*\(/i.test(lines[i])) continue;
    let text = lines[i];
    let j = i;
    while (!text.includes(')') && j + 1 < lines.length) {
      j++;
      text += '\n' + lines[j];
    }
    blocks.push({ text, line: i });
    i = j;
  }
  return blocks;
}

function scanClassBody(content: string): string | undefined {
  const match = /UCLASS\s*\([^)]*\)\s*class[^;{]*\{/i.exec(content);
  if (!match || match.index === undefined) return undefined;
  let i = match.index + match[0].length;
  let depth = 1;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === '\'' && !inString) {
      i++;
      while (i < content.length && content[i] !== '\'') {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === 'R' && next === '"' && content[i + 2] === '(') {
      const close = content.indexOf(')"', i + 3);
      i = close >= 0 ? close + 3 : content.length;
      continue;
    }
    if (ch === '#') {
      const lineEnd = content.indexOf('\n', i);
      i = lineEnd >= 0 ? lineEnd + 1 : content.length;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return content.slice(match.index + match[0].length, i - 1);
}

function collectUclassBlocks(content: string): Array<{ text: string; line: number }> {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ text: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/UCLASS\s*\(/i.test(lines[i])) continue;
    let text = lines[i];
    let j = i;
    while (!/\bclass\b/.test(text) && j + 1 < lines.length) {
      j++;
      text += '\n' + lines[j];
    }
    while (j + 1 < lines.length && !text.includes('{')) {
      j++;
      text += '\n' + lines[j];
    }
    const bodyStart = content.indexOf(text) + text.length;
    const body = scanClassBody(content.slice(Math.max(0, content.indexOf(text))));
    if (body !== undefined) {
      blocks.push({ text: text + '{' + body, line: i });
    } else {
      blocks.push({ text, line: i });
    }
    i = j;
  }
  return blocks;
}

const RULES: FileRule[] = [
  {
    id: 'ue.generated-include-order',
    severity: 'error',
    enabled: true,
    run: (content) => {
      const includes = [...content.matchAll(/#include\s+"([^"]+\.generated\.h)"/gi)];
      if (includes.length === 0) return [];
      const lastInclude = [...content.matchAll(/#include\s+"[^"]+"/g)].pop();
      if (!lastInclude) return [];
      const gen = includes[includes.length - 1];
      if (lastInclude.index === gen.index) return [];
      const line = content.slice(0, gen.index!).split('\n').length - 1;
      return [
        {
          id: 'ue.generated-include-order',
          message: '.generated.h include must be the last #include in the file',
          severity: 'error',
          line,
          column: gen.index! - content.lastIndexOf('\n', gen.index!) - 1,
          length: gen[0].length,
        },
      ];
    },
  },
  {
    id: 'ue.rpc-reliability',
    severity: 'warning',
    enabled: true,
    run: (content) => {
      const hits: UeInspection[] = [];
      for (const block of collectUfunctionBlocks(content)) {
        const isServer = /Server/i.test(block.text);
        const isClient = /Client/i.test(block.text);
        if (!isServer && !isClient) continue;
        if (/WithValidation|Reliable|Unreliable/.test(block.text)) continue;
        hits.push({
          id: 'ue.rpc-reliability',
          message: `${isServer ? 'Server' : 'Client'} RPC should specify Reliable or Unreliable`,
          severity: 'warning',
          line: block.line,
          column: block.text.indexOf('UFUNCTION'),
          length: 8,
        });
      }
      return hits;
    },
  },
  {
    id: 'ue.generated-body-present',
    severity: 'warning',
    enabled: true,
    run: (content) => {
      const hits: UeInspection[] = [];
      for (const block of collectUclassBlocks(content)) {
        if (!/GENERATED_BODY\s*\(\s*\)/.test(block.text)) {
          hits.push({
            id: 'ue.generated-body-present',
            message: 'UCLASS body should contain GENERATED_BODY()',
            severity: 'warning',
            line: block.line,
            column: 0,
            length: 6,
          });
        }
      }
      return hits;
    },
  },
  {
    id: 'ue.bne-implementation-pair',
    severity: 'warning',
    enabled: true,
    run: (content) => {
      const hits: UeInspection[] = [];
      for (const block of collectUfunctionBlocks(content)) {
        if (!/BlueprintNativeEvent/i.test(block.text)) continue;
        const fn = block.text.match(/(\w+)\s*\(/);
        const name = fn?.[1];
        if (!name) continue;
        if (!new RegExp(`\\b${name}_Implementation\\s*\\(`).test(content)) {
          const line = content.slice(0, content.indexOf(block.text)).split('\n').length - 1;
          hits.push({
            id: 'ue.bne-implementation-pair',
            message: `BlueprintNativeEvent ${name} should have ${name}_Implementation in this class`,
            severity: 'warning',
            line,
            column: block.text.indexOf(name),
            length: name.length,
          });
        }
      }
      return hits;
    },
  },
  {
    id: 'ue.delegate-member-uproperty',
    severity: 'warning',
    enabled: true,
    run: (content) => {
      const hits: UeInspection[] = [];
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/DECLARE_\w+_DELEGATE/i.test(line)) continue;
        if (!/\bF\w+Delegate\b/.test(line) || /UPROPERTY/i.test(line)) continue;
        if (/^\s*\/\//.test(line)) continue;
        hits.push({
          id: 'ue.delegate-member-uproperty',
          message: 'Multicast/dynamic delegate member properties should use UPROPERTY',
          severity: 'warning',
          line: i,
          column: line.search(/\bF\w+Delegate\b/),
          length: 8,
        });
      }
      return hits;
    },
  },
];

export function runUeInspections(content: string, enabled = false): UeInspectionResult {
  if (!enabled) {
    return { inspections: [], fingerprint: fingerprint(content) };
  }

  const inspections: UeInspection[] = [];
  for (const rule of RULES) {
    if (!rule.enabled) continue;
    inspections.push(...rule.run(content));
  }

  return { inspections, fingerprint: fingerprint(content) };
}

function fingerprint(content: string): string {
  let fp = 0;
  for (const ch of content) {
    fp = (fp * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return fp.toString(16);
}

export function inspectionsToDiagnostics(uri: vscode.Uri, result: UeInspectionResult): vscode.Diagnostic[] {
  return result.inspections.map((ins) => {
    const range = new vscode.Range(ins.line, ins.column, ins.line, ins.column + ins.length);
    const severity =
      ins.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : ins.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diag = new vscode.Diagnostic(range, ins.message, severity);
    diag.source = 'UE inspection (derived)';
    diag.code = ins.id;
    return diag;
  });
}

export function inspectionRuleCount(): number {
  return RULES.filter((r) => r.enabled).length;
}

export function enabledInspectionIds(): string[] {
  return RULES.filter((r) => r.enabled).map((r) => r.id);
}
