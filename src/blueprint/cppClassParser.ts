/** C++ 헤더에서 UCLASS 선언 파싱 */
export interface ParsedUClass {
  className: string;
  apiMacro: string;
  parentClass: string;
  line: number;
  isBlueprintable: boolean;
  isInterface?: boolean;
  interfaceCompanion?: string;
  interfaceCompanionLine?: number;
}

const UCLASS_LINE = /UCLASS\s*\(([^)]*)\)/;
const UINTERFACE_LINE = /UINTERFACE\s*\(([^)]*)\)/;
const CLASS_LINE = /class\s+(\w+_API)\s+(\w+)\s*:\s*public\s+(\w+)/;
const INTERFACE_CLASS_LINE = /class\s+(\w+)\s*:\s*public\s+(\w+)/;
const ICLASS_LINE = /class\s+(?:\w+_API\s+)?(I[A-Z]\w*)\s*(?::\s*public\s+\w+)?/;

export function interfaceCompanionName(uClassName: string): string {
  if (uClassName.startsWith('U') && uClassName.length > 1 && uClassName[1] === uClassName[1].toUpperCase()) {
    return `I${uClassName.slice(1)}`;
  }
  return `I${uClassName}`;
}

export function findInterfaceCompanionLine(text: string, uClassName: string): number | undefined {
  const companion = interfaceCompanionName(uClassName);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ICLASS_LINE);
    if (match?.[1] === companion) return i;
  }
  return undefined;
}

export function parseUClassFromText(text: string): ParsedUClass[] {
  const lines = text.split(/\r?\n/);
  const results: ParsedUClass[] = [];

  for (let i = 0; i < lines.length; i++) {
    const isInterface = UINTERFACE_LINE.test(lines[i]);
    const uclassMatch = lines[i].match(UCLASS_LINE) ?? lines[i].match(UINTERFACE_LINE);
    if (!uclassMatch) continue;

    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const classMatch = lines[j].match(CLASS_LINE) ?? lines[j].match(INTERFACE_CLASS_LINE);
      if (classMatch) {
        const uclassArgs = uclassMatch[1];
        const hasApiMacro = classMatch.length > 3;
        const className = hasApiMacro ? classMatch[2] : classMatch[1];
        const companionLine = isInterface ? findInterfaceCompanionLine(text, className) : undefined;
        results.push({
          className,
          apiMacro: hasApiMacro ? classMatch[1] : '',
          parentClass: hasApiMacro ? classMatch[3] : classMatch[2],
          line: j,
          isBlueprintable: /Blueprintable|BlueprintType/i.test(uclassArgs) || uclassArgs.trim() === '',
          isInterface,
          interfaceCompanion: companionLine !== undefined ? interfaceCompanionName(className) : undefined,
          interfaceCompanionLine: companionLine,
        });
        break;
      }
    }
  }

  return results;
}

export function stripClassPrefix(className: string): string {
  if (className.startsWith('A') && className.length > 1 && className[1] === className[1].toUpperCase()) {
    return className.slice(1);
  }
  if (className.startsWith('U') && className.length > 1 && className[1] === className[1].toUpperCase()) {
    return className.slice(1);
  }
  return className;
}

export function blueprintNameCandidates(className: string): string[] {
  const base = stripClassPrefix(className);
  return [
    `BP_${className}`,
    `BP_${base}`,
    `BPI_${base}`,
    `WBP_${base}`,
    `ABP_${base}`,
    className,
    base,
  ];
}
