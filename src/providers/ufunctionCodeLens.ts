import * as vscode from 'vscode';
import { parseUClassFromText } from '../blueprint/cppClassParser';
import { parseUFunctions } from '../parsers/ufunctionParser';

function findOwningClass(text: string, functionLine: number): string | undefined {
  const classes = parseUClassFromText(text);
  let best: { className: string; line: number } | undefined;
  for (const cls of classes) {
    if (cls.line <= functionLine && (!best || cls.line > best.line)) {
      best = { className: cls.className, line: cls.line };
    }
  }
  return best?.className;
}

export class UFunctionCodeLensProvider implements vscode.CodeLensProvider {
  constructor(
    private projectRoot: (uri?: vscode.Uri) => string | undefined,
    private bridge: (uri?: vscode.Uri) => import('../editorBridge/editorBridgeClient').EditorBridgeClient | undefined = () => undefined,
  ) {}

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (document.languageId !== 'cpp' || !document.fileName.endsWith('.h')) return [];

    const text = document.getText();
    const funcs = parseUFunctions(text);
    const lenses: vscode.CodeLens[] = [];
    const root = this.projectRoot(document.uri);

    let reflectionByClass: Map<string, Set<string>> | undefined;
    if (root) {
      try {
        const { getReflectionClasses } = await import('../semantic/semanticService');
        const classes = await getReflectionClasses(root);
        reflectionByClass = new Map(
          classes.map((c) => [c.className.toLowerCase(), new Set(c.functions.map((f) => f.name))]),
        );
      } catch {
        // ignore
      }
    }

    for (const fn of funcs) {
      const range = new vscode.Range(fn.line, 0, fn.line, 0);
      const badges: string[] = [];
      if (fn.isBlueprintCallable) badges.push('BP Callable');
      if (fn.isBlueprintPure) badges.push('BP Pure');
      const className = findOwningClass(text, fn.line);
      const inReflection =
        className && reflectionByClass?.get(className.toLowerCase())?.has(fn.name);

      if (inReflection) badges.push('Reflection');
      const title = badges.length > 0 ? `$(symbol-event) ${badges.join(' · ')}` : '$(symbol-event) UFUNCTION';

      lenses.push(
        new vscode.CodeLens(range, {
          title,
          tooltip: `UFUNCTION(${fn.flags.join(', ')})`,
          command: 'ue58rider.showUFunctionInfo',
          arguments: [fn.name, fn.flags],
        }),
      );

      if (fn.isBlueprintCallable || fn.isBlueprintPure) {
        const showBpLens = !reflectionByClass || inReflection || !className;
        if (showBpLens) {
          const bridgeHint = this.bridge(document.uri)?.isConnected() ? ' (Bridge)' : '';
          lenses.push(
            new vscode.CodeLens(range, {
              title: '$(link-external) Find BP usages',
              tooltip: `${className ?? 'Class'}::${fn.name} Blueprint 노드 검색${bridgeHint}`,
              command: 'ue58rider.findUFunctionBlueprints',
              arguments: [fn.name, className, document.uri.fsPath],
            }),
          );
        }
      }
    }

    return lenses;
  }
}
