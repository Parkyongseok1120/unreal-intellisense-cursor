import * as vscode from 'vscode';
import { getReflectionClasses } from '../../semantic/semanticService';
import { parseHeaderUProperties } from '../generatedHeaderParser';
import type { UClassReflection } from '../generatedHeaderParser';

function findEnclosingClass(document: vscode.TextDocument, line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const text = document.lineAt(i).text;
    const m = text.match(/UCLASS\s*\([^)]*\)\s*class\s+\w+\s+(\w+)/);
    if (m) return m[1];
    const m2 = text.match(/class\s+(\w+)\s*:\s*public/);
    if (m2 && i < line) return m2[1];
  }
  return undefined;
}

export class UPropertyCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private projectRoot: () => string | undefined) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const root = this.projectRoot();
    if (!root || document.languageId !== 'cpp') return [];

    const lenses: vscode.CodeLens[] = [];
    const props = parseHeaderUProperties(document.getText());

    for (const prop of props) {
      if (prop.line === undefined) continue;
      const line = prop.line - 1;
      const range = new vscode.Range(line, 0, line, 0);
      const title = prop.meta ? `UPROPERTY: ${prop.type} (${prop.meta.slice(0, 40)})` : `UPROPERTY: ${prop.type}`;
      lenses.push(new vscode.CodeLens(range, { title, command: 'ue58rider.showUFunctionInfo', arguments: [prop.name, [prop.type]] }));
    }

    if (lenses.length === 0) {
      const classes = await getReflectionClasses(root);
      const className = findEnclosingClass(document, document.lineCount - 1);
      if (className) {
        const reflection = classes.find((c: UClassReflection) => c.className.toLowerCase() === className.toLowerCase());
        if (reflection) {
          for (const prop of reflection.properties) {
            lenses.push(
              new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: `${reflection.className}.${prop.name}: ${prop.type}`,
                command: 'ue58rider.showUFunctionInfo',
                arguments: [prop.name, [prop.type]],
              }),
            );
          }
        }
      }
    }

    return lenses;
  }
}

export class GeneratedSymbolHoverProvider implements vscode.HoverProvider {
  constructor(private projectRoot: () => string | undefined) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const root = this.projectRoot();
    if (!root) return undefined;

    const line = document.lineAt(position.line).text;
    if (!line.includes('GENERATED_BODY')) return undefined;

    const className = findEnclosingClass(document, position.line);
    if (!className) return undefined;

    const classes = await getReflectionClasses(root);
    const reflection = classes.find((c: UClassReflection) => c.className.toLowerCase() === className.toLowerCase());
    if (!reflection) return undefined;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${reflection.className}**`);
    if (reflection.superClass) md.appendMarkdown(` : ${reflection.superClass}`);
    md.appendMarkdown('\n\n');

    if (reflection.properties.length > 0) {
      md.appendMarkdown('**Properties:**\n');
      for (const p of reflection.properties.slice(0, 15)) {
        md.appendMarkdown(`- \`${p.name}\` : ${p.type}\n`);
      }
    }
    if (reflection.functions.length > 0) {
      md.appendMarkdown('\n**Functions:**\n');
      for (const f of reflection.functions.slice(0, 15)) {
        md.appendMarkdown(`- \`${f.name}()\`\n`);
      }
    }

    return new vscode.Hover(md);
  }
}

export function formatReflectionSummary(reflection: UClassReflection): string {
  return `${reflection.className}: ${reflection.properties.length} properties, ${reflection.functions.length} functions`;
}
