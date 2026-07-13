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
}

export function parseGeneratedHeader(content: string, filePath: string): UClassReflection[] {
  const classes: UClassReflection[] = [];
  const classNameMatch = content.match(/class\s+(\w+)\s*:\s*public\s+(\w+)/);
  const structMatch = content.match(/struct\s+(\w+)\s*:\s*public\s+(\w+)/);

  const className = classNameMatch?.[1] ?? structMatch?.[1];
  if (!className) return classes;

  const reflection: UClassReflection = {
    className,
    superClass: classNameMatch?.[2] ?? structMatch?.[2],
    filePath,
    properties: [],
    functions: [],
  };

  const propRe = /static\s+const\s+UECodeGen_Private::FPropertyParamsBase\*\s+const\s+PropPointers\[\];/g;
  if (propRe.test(content)) {
    const nameRe = /static\s+const\s+UECodeGen_Private::FMetaDataPairParam\s+(\w+)_MetaData\[\]/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(content)) !== null) {
      const propName = m[1].replace(/_MetaData$/, '');
      reflection.properties.push({ name: propName, type: 'UProperty' });
    }
  }

  const funcRe = /static\s+const\s+UECodeGen_Private::FFunctionParams\s+FuncParams;/g;
  if (funcRe.test(content)) {
    const funcNameRe = /UFunction\s*\(\s*[^)]*\)\s+static\s+\w+\s+(\w+)\s*\(/g;
    let fm: RegExpExecArray | null;
    while ((fm = funcNameRe.exec(content)) !== null) {
      reflection.functions.push({ name: fm[1] });
    }
  }

  const execRe = /(\w+)_Implementation\s*\(/g;
  let em: RegExpExecArray | null;
  while ((em = execRe.exec(content)) !== null) {
    const fn = em[1];
    if (!reflection.functions.some((f) => f.name === fn)) {
      reflection.functions.push({ name: fn, flags: 'BlueprintNativeEvent' });
    }
  }

  classes.push(reflection);
  return classes;
}

export function parseHeaderUProperties(content: string): UPropertyInfo[] {
  const props: UPropertyInfo[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('UPROPERTY')) continue;

    let meta = '';
    if (line.includes('UPROPERTY(')) {
      const metaMatch = line.match(/UPROPERTY\s*\(([^)]*)\)/);
      meta = metaMatch?.[1] ?? '';
    }

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
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

export function parseHeaderUFunctions(content: string): UFunctionInfo[] {
  const funcs: UFunctionInfo[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('UFUNCTION')) continue;
    const flagsMatch = line.match(/UFUNCTION\s*\(([^)]*)\)/);
    const flags = flagsMatch?.[1] ?? '';

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
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
