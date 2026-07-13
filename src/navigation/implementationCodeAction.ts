import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import {
  findEnclosingUeClass,
  isHeaderMethodDeclarationLine,
  isUfunctionMethodContext,
} from './symbolNavigation';
import { methodImplementationExists } from './implementationHelpers';

export interface MethodStubRequest {
  headerPath: string;
  className: string;
  methodName: string;
  declarationLine: string;
  isBlueprintNativeEvent: boolean;
}

export function parseMethodStubRequest(
  document: vscode.TextDocument,
  position: vscode.Position,
): MethodStubRequest | undefined {
  if (!/\.h$/i.test(document.fileName)) return undefined;
  const symbol = document.getText(document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/));
  if (!symbol) return undefined;
  if (!isHeaderMethodDeclarationLine(document, position, symbol) && !isUfunctionMethodContext(document, position, symbol)) {
    return undefined;
  }

  const className = findEnclosingUeClass(document, position.line);
  if (!className) return undefined;

  const line = document.lineAt(position.line).text;
  if (/=\s*0\s*;/.test(line) || /= default;|= delete;/.test(line)) return undefined;
  if (/\{/.test(line) && !/;\s*$/.test(line.trim())) return undefined;

  const blockStart = Math.max(0, position.line - 8);
  const block = document.getText(
    new vscode.Range(new vscode.Position(blockStart, 0), new vscode.Position(position.line, line.length)),
  );

  return {
    headerPath: document.fileName,
    className,
    methodName: symbol,
    declarationLine: line,
    isBlueprintNativeEvent: /BlueprintNativeEvent/i.test(block),
  };
}

export function buildImplementationStub(request: MethodStubRequest): string {
  const targetMethod = request.isBlueprintNativeEvent && !request.methodName.endsWith('_Implementation')
    ? `${request.methodName}_Implementation`
    : request.methodName;

  const decl = request.declarationLine.trim();
  const virtualMatch = decl.match(
    /^([\s\S]*?\b(?:virtual\s+)?[\w:<>,\s*&]+)\s+(\w+)\s*\(([^)]*)\)\s*(const)?\s*(?:override|final)?\s*;/,
  );
  if (!virtualMatch) {
    return `${request.className}::${targetMethod}()\n{\n}\n`;
  }

  const returnAndQualifiers = virtualMatch[1].replace(/\bvirtual\b/g, '').trim();
  const params = virtualMatch[3].trim();
  const constSuffix = virtualMatch[4] ? ' const' : '';
  const overrideSuffix = /\boverride\b/.test(decl) ? ' override' : '';

  return `${returnAndQualifiers} ${request.className}::${targetMethod}(${params})${constSuffix}${overrideSuffix}\n{\n}\n`;
}

function headerIncludeName(headerPath: string): string {
  return path.basename(headerPath);
}

function findClassSectionInsertLine(cppContent: string, className: string): number {
  const lines = cppContent.split(/\r?\n/);
  let lastMethodLine = -1;
  const methodPattern = new RegExp(`\\b${className}::\\w+`);
  for (let i = 0; i < lines.length; i++) {
    if (methodPattern.test(lines[i])) lastMethodLine = i;
  }
  if (lastMethodLine >= 0) {
    let end = lastMethodLine + 1;
    while (end < lines.length && lines[end].trim() !== '}') end++;
    return end;
  }
  return lines.length;
}

export function buildCppInsertEdit(
  headerDocument: vscode.TextDocument,
  request: MethodStubRequest,
  cppPath: string,
): vscode.WorkspaceEdit | undefined {
  if (methodImplementationExists(cppPath, request.className, request.methodName)) return undefined;
  if (request.isBlueprintNativeEvent) {
    const implName = `${request.methodName}_Implementation`;
    if (methodImplementationExists(cppPath, request.className, implName)) return undefined;
  }

  let cppContent = '';
  try {
    cppContent = fs.readFileSync(cppPath, 'utf-8');
  } catch {
    return undefined;
  }

  const stub = buildImplementationStub(request);
  const edit = new vscode.WorkspaceEdit();
  const includeName = headerIncludeName(request.headerPath);
  if (!new RegExp(`#include\\s+"${includeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(cppContent)) {
    const firstInclude = cppContent.indexOf('#include');
    const insertPos = firstInclude >= 0
      ? new vscode.Position(0, 0)
      : new vscode.Position(0, 0);
    if (firstInclude >= 0) {
      const line = cppContent.slice(0, firstInclude).split('\n').length - 1;
      edit.insert(vscode.Uri.file(cppPath), new vscode.Position(line, 0), `#include "${includeName}"\n`);
    } else {
      edit.insert(vscode.Uri.file(cppPath), new vscode.Position(0, 0), `#include "${includeName}"\n\n`);
    }
  }

  const insertLine = findClassSectionInsertLine(cppContent, request.className);
  const linePos = new vscode.Position(insertLine, 0);
  edit.insert(vscode.Uri.file(cppPath), linePos, `\n${stub}`);
  return edit;
}

export class UeImplementationCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly enabled: () => boolean) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!this.enabled()) return [];
    const actions: vscode.CodeAction[] = [];

    const inspectionDiags = [
      ...context.diagnostics,
      ...(vscode.languages.getDiagnostics(document.uri) ?? []),
    ].filter((diag) => diag.source === 'UE inspection (derived)' && String(diag.code) === 'ue.bne-implementation-pair');

    for (const diag of inspectionDiags) {
      const action = this.createGenerateAction(document, diag.range.start, 'Generate _Implementation in .cpp');
      if (action) {
        action.diagnostics = [diag];
        actions.push(action);
      }
    }

    const request = parseMethodStubRequest(document, range.start);
    if (request) {
      const action = this.createGenerateAction(document, range.start, 'Generate implementation in .cpp');
      if (action) actions.push(action);
    }

    return actions;
  }

  private createGenerateAction(
    document: vscode.TextDocument,
    position: vscode.Position,
    title: string,
  ): vscode.CodeAction | undefined {
    const request = parseMethodStubRequest(document, position);
    if (!request) return undefined;

    const paired = findPairedSourceFile(document.fileName);
    if (!paired) return undefined;

    const edit = buildCppInsertEdit(document, request, paired);
    if (!edit) return undefined;

    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.edit = edit;
    return action;
  }
}
