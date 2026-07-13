import * as path from 'path';
import * as vscode from 'vscode';
import type { UEProject } from '../types';
import { Commands } from '../constants';
import { findPairedSourceFile } from '../parsers/moduleLayout';
import {
  filterStubLocations,
  isUhtMacroToken,
  normalizeDefinitionLocations,
} from './stubPaths';
import {
  getSymbolAtPosition,
  isPriorityPairedNavigationCandidate,
  pickBestDefinitionLocation,
  resolvePairedFileNavigation,
  resolveUeNavigationTarget,
} from './symbolNavigation';

type ProjectGetter = () => UEProject | undefined;

async function openLocation(location: vscode.Location, preserveFocus = false): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  const editor = await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(location.range.start, location.range.start),
    preserveFocus,
  });
  editor.revealRange(location.range, vscode.TextEditorRevealType?.InCenter ?? 0);
}

async function collectFilteredClangdDefinitions(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand<
    vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
  >('vscode.executeDefinitionProvider', document.uri, position);
  return filterStubLocations(normalizeDefinitionLocations(raw));
}

async function resolvePriorityUeLocation(
  document: vscode.TextDocument,
  position: vscode.Position,
  symbol: { word: string } | undefined,
  project: UEProject | undefined,
  mode: 'definition' | 'implementation' = 'definition',
): Promise<vscode.Location | undefined> {
  if (!symbol) return undefined;

  if (symbol.word === 'StaticClass') {
    return resolveUeNavigationTarget(document, position, {
      project,
      mode: 'definition',
    });
  }

  const pairedLoc = isPriorityPairedNavigationCandidate(document, position, symbol.word, mode)
    ? resolvePairedFileNavigation(document, position, symbol.word, mode)
    : undefined;
  if (pairedLoc) {
    const current = path.normalize(document.fileName).toLowerCase();
    const target = path.normalize(pairedLoc.uri.fsPath).toLowerCase();
    if (target !== current) return pairedLoc;
    if (mode === 'implementation') {
      const line = document.lineAt(position.line).text;
      if (new RegExp(`\\w+::${symbol.word}\\s*\\(`).test(line)) return pairedLoc;
    }
  }

  return undefined;
}

function pickOptions(document: vscode.TextDocument, project: UEProject | undefined) {
  return {
    projectRoot: project?.projectRoot,
    pairedFilePath: findPairedSourceFile(document.fileName),
    engineRoot: undefined as string | undefined,
  };
}

export async function goToDefinition(getProject: ProjectGetter): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'cpp') {
    await vscode.commands.executeCommand('editor.action.revealDefinition');
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const symbol = getSymbolAtPosition(document, position);
  const project = getProject();

  if (symbol && isUhtMacroToken(symbol.word)) {
    vscode.window.showInformationMessage(
      'UE5_8 Cursor: UHT 매크로는 IDE 스텁입니다. 함수 이름에 F12를 사용하세요.',
    );
    return;
  }

  const priorityUe = await resolvePriorityUeLocation(document, position, symbol, project);
  if (priorityUe) {
    await openLocation(priorityUe);
    return;
  }

  const filtered = await collectFilteredClangdDefinitions(document, position);
  const clangdBest = pickBestDefinitionLocation(filtered, document, symbol?.word, pickOptions(document, project));
  if (clangdBest) {
    await openLocation(clangdBest);
    return;
  }

  const ueLocation = await resolveUeNavigationTarget(document, position, {
    project,
    mode: 'definition',
  });
  if (ueLocation) {
    await openLocation(ueLocation);
    return;
  }

  vscode.window.showWarningMessage('UE5_8 Cursor: 정의를 찾지 못했습니다.');
}

export async function goToImplementation(getProject: ProjectGetter): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'cpp') {
    await vscode.commands.executeCommand('editor.action.goToImplementation');
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const symbol = getSymbolAtPosition(document, position);
  const project = getProject();

  if (symbol && isUhtMacroToken(symbol.word)) {
    vscode.window.showInformationMessage(
      'UE5_8 Cursor: UHT 매크로는 IDE 스텁입니다. 함수 이름에 Ctrl+F12를 사용하세요.',
    );
    return;
  }

  const priorityUe = await resolvePriorityUeLocation(document, position, symbol, project, 'implementation');
  if (priorityUe) {
    await openLocation(priorityUe);
    return;
  }

  const raw = await vscode.commands.executeCommand<
    vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
  >('vscode.executeImplementationProvider', document.uri, position);
  const filtered = filterStubLocations(normalizeDefinitionLocations(raw));
  const clangdBest = pickBestDefinitionLocation(filtered, document, symbol?.word, pickOptions(document, project));
  if (clangdBest) {
    await openLocation(clangdBest);
    return;
  }

  const ueLocation = await resolveUeNavigationTarget(document, position, {
    project,
    mode: 'implementation',
  });
  if (ueLocation) {
    await openLocation(ueLocation);
    return;
  }

  const definitionFallback = await collectFilteredClangdDefinitions(document, position);
  const definitionBest = pickBestDefinitionLocation(
    definitionFallback,
    document,
    symbol?.word,
    pickOptions(document, project),
  );
  if (definitionBest && definitionBest.uri.fsPath.toLowerCase() !== document.fileName.toLowerCase()) {
    await openLocation(definitionBest);
    return;
  }

  vscode.window.showWarningMessage('UE5_8 Cursor: 구현을 찾지 못했습니다.');
}

export function registerUeNavigationCommands(
  context: vscode.ExtensionContext,
  getProject: ProjectGetter,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GoToDefinition, () => goToDefinition(getProject)),
    vscode.commands.registerCommand(Commands.GoToImplementation, () => goToImplementation(getProject)),
  );
}
