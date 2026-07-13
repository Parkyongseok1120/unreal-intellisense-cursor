import * as path from 'path';
import { parseUClassFromText } from '../blueprint/cppClassParser';
import type { UClassReflection } from '../uht/generatedHeaderParser';

export interface DeclarationRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolMember {
  kind: 'property' | 'function';
  name: string;
  line: number;
}

export function buildStableSymbolId(moduleName: string | undefined, className: string, sourceFile: string): string {
  const mod = moduleName ?? 'unknown';
  return `${mod}@${className}@${path.normalize(sourceFile).replace(/\\/g, '/').toLowerCase()}`;
}

export function declarationRangeFromClassLine(classLine: number, className: string): DeclarationRange {
  const column = Math.max(0, `class `.length);
  return {
    startLine: classLine,
    startColumn: column,
    endLine: classLine,
    endColumn: column + className.length,
  };
}

export function enrichReflectionFromHeaderContent(
  reflection: UClassReflection,
  content: string,
  headerPath: string,
): void {
  reflection.filePath = headerPath;
  const parsed = parseUClassFromText(content).find((c) => c.className === reflection.className);
  if (parsed) {
    reflection.classLine = parsed.line;
    reflection.superClass = parsed.parentClass;
    reflection.declarationRange = declarationRangeFromClassLine(parsed.line, parsed.className);
    if (parsed.interfaceCompanion) {
      reflection.interfaceCompanion = parsed.interfaceCompanion;
    }
  } else {
    const fallback = content.match(/UCLASS\s*\([^)]*\)\s*class\s+\w+\s+(\w+)/);
    if (fallback) {
      const line = content.slice(0, fallback.index ?? 0).split(/\r?\n/).length - 1;
      reflection.classLine = Math.max(0, line);
      reflection.declarationRange = declarationRangeFromClassLine(reflection.classLine, reflection.className);
    }
  }

  reflection.members = [
    ...reflection.properties.map((p) => ({ kind: 'property' as const, name: p.name, line: p.line ?? 0 })),
    ...reflection.functions.map((f) => ({ kind: 'function' as const, name: f.name, line: f.line ?? 0 })),
  ];
}
