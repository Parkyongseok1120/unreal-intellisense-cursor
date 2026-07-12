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

type LineRule = {
  id: string;
  severity: InspectionSeverity;
  test: (line: string, lineNo: number, allLines: string[]) => UeInspection | undefined;
};

const RULES: LineRule[] = [
  {
    id: 'ue.generated-body-scope',
    severity: 'error',
    test: (line, lineNo) => {
      if (!/\bGENERATED_BODY\s*\(\s*\)/.test(line)) return undefined;
      return {
        id: 'ue.generated-body-scope',
        message: 'GENERATED_BODY() must be the first statement in the class body',
        severity: 'error',
        line: lineNo,
        column: line.indexOf('GENERATED_BODY'),
        length: 14,
      };
    },
  },
  {
    id: 'ue.rpc-server-spec',
    severity: 'warning',
    test: (line, lineNo) => {
      if (!/UFUNCTION\s*\([^)]*Server[^)]*\)/i.test(line)) return undefined;
      if (/WithValidation|Reliable|Unreliable/.test(line)) return undefined;
      return {
        id: 'ue.rpc-server-spec',
        message: 'Server RPC should specify Reliable or Unreliable',
        severity: 'warning',
        line: lineNo,
        column: line.indexOf('UFUNCTION'),
        length: 8,
      };
    },
  },
  {
    id: 'ue.rpc-client-spec',
    severity: 'warning',
    test: (line, lineNo) => {
      if (!/UFUNCTION\s*\([^)]*Client[^)]*\)/i.test(line)) return undefined;
      if (/WithValidation|Reliable|Unreliable/.test(line)) return undefined;
      return {
        id: 'ue.rpc-client-spec',
        message: 'Client RPC should specify Reliable or Unreliable',
        severity: 'warning',
        line: lineNo,
        column: line.indexOf('UFUNCTION'),
        length: 8,
      };
    },
  },
  {
    id: 'ue.delegate-ufunction',
    severity: 'error',
    test: (line, lineNo) => {
      if (!/DECLARE_DYNAMIC_MULTICAST_DELEGATE/.test(line)) return undefined;
      const nextCtx = line;
      if (/UFUNCTION/.test(nextCtx)) return undefined;
      return {
        id: 'ue.delegate-ufunction',
        message: 'Dynamic multicast delegates exposed to Blueprint need UPROPERTY on the delegate member',
        severity: 'error',
        line: lineNo,
        column: 0,
        length: Math.max(1, line.trim().length),
      };
    },
  },
  {
    id: 'ue.uproperty-blueprint-readonly',
    severity: 'information',
    test: (line, lineNo) => {
      if (!/UPROPERTY\s*\([^)]*BlueprintReadOnly[^)]*\)/i.test(line)) return undefined;
      if (/meta\s*=\s*\(/.test(line)) return undefined;
      return {
        id: 'ue.uproperty-blueprint-readonly',
        message: 'Consider adding meta=(AllowPrivateAccess) for BlueprintReadOnly private fields',
        severity: 'information',
        line: lineNo,
        column: line.indexOf('UPROPERTY'),
        length: 9,
      };
    },
  },
  {
    id: 'ue.uclass-abstract-mismatch',
    severity: 'warning',
    test: (line, lineNo) => {
      if (!/UCLASS\s*\([^)]*Abstract[^)]*\)/i.test(line)) return undefined;
      if (/\bclass\s+[A-Z]\w+\s*:\s*public\s+AActor/.test(line)) return undefined;
      return {
        id: 'ue.uclass-abstract-mismatch',
        message: 'Abstract UCLASS on non-actor types should be reviewed for instantiation sites',
        severity: 'warning',
        line: lineNo,
        column: line.indexOf('UCLASS'),
        length: 6,
      };
    },
  },
  {
    id: 'ue.ufunction-blueprint-callable-static',
    severity: 'warning',
    test: (line, lineNo) => {
      if (!/UFUNCTION\s*\([^)]*BlueprintCallable[^)]*\)/i.test(line)) return undefined;
      if (!/\bstatic\b/.test(line)) return undefined;
      return {
        id: 'ue.ufunction-blueprint-callable-static',
        message: 'BlueprintCallable on static UFUNCTION may not be invokable from all Blueprint contexts',
        severity: 'warning',
        line: lineNo,
        column: line.indexOf('UFUNCTION'),
        length: 8,
      };
    },
  },
  {
    id: 'ue.uproperty-edit-defaults-only',
    severity: 'information',
    test: (line, lineNo) => {
      if (!/UPROPERTY\s*\([^)]*EditDefaultsOnly[^)]*\)/i.test(line)) return undefined;
      return {
        id: 'ue.uproperty-edit-defaults-only',
        message: 'EditDefaultsOnly is not editable on placed instances in editor',
        severity: 'information',
        line: lineNo,
        column: line.indexOf('UPROPERTY'),
        length: 9,
      };
    },
  },
  {
    id: 'ue.uenum-missing',
    severity: 'error',
    test: (line, lineNo, allLines) => {
      if (!/\benum\s+class\s+[A-Z]\w+/.test(line)) return undefined;
      if (/UENUM\s*\(/.test(line)) return undefined;
      const prev = allLines.slice(Math.max(0, lineNo - 2), lineNo).join('\n');
      if (/UENUM\s*\(/.test(prev)) return undefined;
      return {
        id: 'ue.uenum-missing',
        message: 'Reflected enum should use UENUM() macro',
        severity: 'error',
        line: lineNo,
        column: line.search(/enum\s+class/),
        length: 10,
      };
    },
  },
  {
    id: 'ue.ustruct-missing',
    severity: 'error',
    test: (line, lineNo, allLines) => {
      if (!/\bstruct\s+[A-Z]\w+/.test(line)) return undefined;
      if (/USTRUCT\s*\(/.test(line)) return undefined;
      const prev = allLines.slice(Math.max(0, lineNo - 2), lineNo).join('\n');
      if (/USTRUCT\s*\(/.test(prev)) return undefined;
      return {
        id: 'ue.ustruct-missing',
        message: 'Reflected struct should use USTRUCT() macro',
        severity: 'error',
        line: lineNo,
        column: line.search(/struct\s+[A-Z]/),
        length: 6,
      };
    },
  },
  {
    id: 'ue.generated-include-order',
    severity: 'warning',
    test: (line, lineNo) => {
      if (!/\.generated\.h/.test(line)) return undefined;
      if (!/#include/.test(line)) return undefined;
      return {
        id: 'ue.generated-include-order',
        message: '.generated.h include should be the last include in the header',
        severity: 'warning',
        line: lineNo,
        column: line.indexOf('#include'),
        length: 8,
      };
    },
  },
  {
    id: 'ue.ufunction-implementation-missing',
    severity: 'information',
    test: (line, lineNo) => {
      if (!/UFUNCTION\s*\([^)]*BlueprintNativeEvent[^)]*\)/i.test(line)) return undefined;
      return {
        id: 'ue.ufunction-implementation-missing',
        message: 'BlueprintNativeEvent requires _Implementation in cpp (quick fix disabled until signature resolution)',
        severity: 'information',
        line: lineNo,
        column: line.indexOf('UFUNCTION'),
        length: 8,
      };
    },
  },
];

export function runUeInspections(content: string): UeInspectionResult {
  const lines = content.split(/\r?\n/);
  const inspections: UeInspection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      const hit = rule.test(line, i, lines);
      if (hit) inspections.push(hit);
    }
  }

  let fp = 0;
  for (const ch of content) {
    fp = (fp * 31 + ch.charCodeAt(0)) >>> 0;
  }

  return { inspections, fingerprint: fp.toString(16) };
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
    diag.source = 'UE inspection';
    diag.code = ins.id;
    return diag;
  });
}

export function inspectionRuleCount(): number {
  return RULES.length;
}
