import { parseUClassFromText } from '../blueprint/cppClassParser';

export interface UPropertyInfo {
  name: string;
  type: string;
  meta?: string;
  line?: number;
}

export interface UFunctionInfo {
  name: string;
  returnType?: string;
  params?: string;
  flags?: string;
  line?: number;
}

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

export interface UClassReflection {
  className: string;
  superClass?: string;
  filePath: string;
  classLine?: number;
  declarationRange?: DeclarationRange;
  properties: UPropertyInfo[];
  functions: UFunctionInfo[];
  members?: SymbolMember[];
  interfaceCompanion?: string;
}

export interface ClassBodyRange {
  className: string;
  startLine: number;
  endLine: number;
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

export function findClassBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

export function getClassBodyRanges(content: string, classNames?: string[]): ClassBodyRange[] {
  const lines = splitLines(content);
  const parsed = parseUClassFromText(content);
  const wanted = classNames ? new Set(classNames) : undefined;
  return parsed
    .filter((p) => !wanted || wanted.has(p.className))
    .map((p) => ({
      className: p.className,
      startLine: p.line,
      endLine: findClassBlockEnd(lines, p.line),
    }));
}

function sliceClassBody(content: string, range: ClassBodyRange): string {
  const lines = splitLines(content);
  return lines.slice(range.startLine, range.endLine + 1).join('\n');
}

export function parseGeneratedHeader(content: string, filePath: string): UClassReflection[] {
  const classes: UClassReflection[] = [];
  const classDeclRe = /(?:class|struct)\s+(\w+)\s*:\s*public\s+(\w+)/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = classDeclRe.exec(content)) !== null) {
    const className = match[1];
    if (seen.has(className)) continue;
    seen.add(className);

    const blockStartLine = content.slice(0, match.index).split(/\r?\n/).length - 1;
    const blockLines = splitLines(content);
    const blockEndLine = findClassBlockEnd(blockLines, blockStartLine);
    const scoped = blockLines.slice(blockStartLine, blockEndLine + 1).join('\n');

    const reflection: UClassReflection = {
      className,
      superClass: match[2],
      filePath,
      classLine: blockStartLine,
      properties: [],
      functions: [],
    };

    const nameRe = /static\s+const\s+UECodeGen_Private::FMetaDataPairParam\s+(\w+)_MetaData\[\]/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(scoped)) !== null) {
      const propName = m[1].replace(/_MetaData$/, '');
      const line = blockStartLine + scoped.slice(0, m.index).split(/\r?\n/).length - 1;
      reflection.properties.push({ name: propName, type: 'UProperty', line });
    }

    const funcRe = /static\s+const\s+UECodeGen_Private::FFunctionParams\s+FuncParams;/g;
    if (funcRe.test(scoped)) {
      const funcNameRe = /UFunction\s*\(\s*[^)]*\)\s+static\s+\w+\s+(\w+)\s*\(/g;
      let fm: RegExpExecArray | null;
      while ((fm = funcNameRe.exec(scoped)) !== null) {
        const line = scoped.slice(0, fm.index).split(/\r?\n/).length;
        reflection.functions.push({ name: fm[1], line });
      }
    }

    const execRe = /(\w+)_Implementation\s*\(/g;
    let em: RegExpExecArray | null;
    while ((em = execRe.exec(scoped)) !== null) {
      const fn = em[1];
      if (!reflection.functions.some((f) => f.name === fn)) {
        const line = scoped.slice(0, em.index).split(/\r?\n/).length;
        reflection.functions.push({ name: fn, flags: 'BlueprintNativeEvent', line });
      }
    }

    classes.push(reflection);
  }

  if (classes.length > 0) return classes;

  const classNameMatch = content.match(/class\s+(\w+)\s*:\s*public\s+(\w+)/);
  const structMatch = content.match(/struct\s+(\w+)\s*:\s*public\s+(\w+)/);
  const className = classNameMatch?.[1] ?? structMatch?.[1];
  if (!className) return classes;

  return parseGeneratedHeader(
    `class ${className} : public ${classNameMatch?.[2] ?? structMatch?.[2]}\n${content}`,
    filePath,
  );
}

export function parseHeaderUProperties(content: string, range?: ClassBodyRange): UPropertyInfo[] {
  const props: UPropertyInfo[] = [];
  const lines = splitLines(content);
  const start = range?.startLine ?? 0;
  const end = range?.endLine ?? lines.length - 1;

  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('UPROPERTY')) continue;

    let meta = '';
    if (line.includes('UPROPERTY(')) {
      const metaMatch = line.match(/UPROPERTY\s*\(([^)]*)\)/);
      meta = metaMatch?.[1] ?? '';
    }

    for (let j = i + 1; j < Math.min(i + 4, end + 1, lines.length); j++) {
      const decl = lines[j].trim();
      const m = decl.match(/^([\w:<>,\s*&]+)\s+(\w+)\s*;/);
      if (m) {
        props.push({ name: m[2], type: m[1].trim(), meta, line: j + 1 });
        break;
      }
    }
  }
  return props;
}

export function parseHeaderUFunctions(content: string, range?: ClassBodyRange): UFunctionInfo[] {
  const funcs: UFunctionInfo[] = [];
  const lines = splitLines(content);
  const start = range?.startLine ?? 0;
  const end = range?.endLine ?? lines.length - 1;

  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('UFUNCTION')) continue;
    const flagsMatch = line.match(/UFUNCTION\s*\(([^)]*)\)/);
    const flags = flagsMatch?.[1] ?? '';

    for (let j = i + 1; j < Math.min(i + 4, end + 1, lines.length); j++) {
      const decl = lines[j].trim();
      const m = decl.match(/^([\w:<>,\s*&]+)\s+(\w+)\s*\(([^)]*)\)\s*;/);
      if (m) {
        funcs.push({ name: m[2], returnType: m[1].trim(), params: m[3], flags, line: j + 1 });
        break;
      }
    }
  }
  return funcs;
}

export function parseHeaderMembersForClass(content: string, className: string): {
  properties: UPropertyInfo[];
  functions: UFunctionInfo[];
} {
  const range = getClassBodyRanges(content, [className])[0];
  if (!range) return { properties: [], functions: [] };
  return {
    properties: parseHeaderUProperties(content, range),
    functions: parseHeaderUFunctions(content, range),
  };
}
