/** C++ 헤더에서 UCLASS 선언 파싱 */
export interface ParsedUClass {
  className: string;
  apiMacro: string;
  parentClass: string;
  line: number;
  isBlueprintable: boolean;
}

const UCLASS_LINE = /UCLASS\s*\(([^)]*)\)/;
const UINTERFACE_LINE = /UINTERFACE\s*\(([^)]*)\)/;
const CLASS_LINE = /class\s+(\w+_API)\s+(\w+)\s*:\s*public\s+(\w+)/;
const INTERFACE_CLASS_LINE = /class\s+(\w+)\s*:\s*public\s+(\w+)/;

export function parseUClassFromText(text: string): ParsedUClass[] {
  const lines = text.split(/\r?\n/);
  const results: ParsedUClass[] = [];

  for (let i = 0; i < lines.length; i++) {
    const uclassMatch = lines[i].match(UCLASS_LINE) ?? lines[i].match(UINTERFACE_LINE);
    if (!uclassMatch) continue;

    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const classMatch = lines[j].match(CLASS_LINE) ?? lines[j].match(INTERFACE_CLASS_LINE);
      if (classMatch) {
        const uclassArgs = uclassMatch[1];
        const hasApiMacro = classMatch.length > 3;
        results.push({
          className: hasApiMacro ? classMatch[2] : classMatch[1],
          apiMacro: hasApiMacro ? classMatch[1] : '',
          parentClass: hasApiMacro ? classMatch[3] : classMatch[2],
          line: j,
          isBlueprintable: /Blueprintable|BlueprintType/i.test(uclassArgs) || uclassArgs.trim() === '',
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
