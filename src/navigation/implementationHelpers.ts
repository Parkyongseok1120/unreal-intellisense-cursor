import * as fs from 'fs';
import { findMethodSignatureInSource } from './symbolNavigation';

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function findSymbolInFile(filePath: string, patterns: RegExp[]): { line: number; column: number } | undefined {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[i]);
      if (match) return { line: i, column: match.index ?? 0 };
    }
  }
  return undefined;
}

export function methodImplementationExists(
  sourcePath: string,
  className: string | undefined,
  methodName: string,
): boolean {
  if (findMethodSignatureInSource(sourcePath, className, methodName)) return true;
  const patterns = [
    new RegExp(`\\b${escapeRegex(methodName)}\\s*\\([^)]*\\)\\s*(?:const)?\\s*\\{`),
    new RegExp(`\\b${escapeRegex(methodName)}_Implementation\\s*\\(`),
  ];
  return findSymbolInFile(sourcePath, patterns) !== undefined;
}
