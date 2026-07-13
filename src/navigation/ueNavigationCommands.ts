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
import { findUeReferences } from './referenceNavigation';
import {
  getSymbolAtPosition,
  isPriorityPairedNavigationCandidate,
  pickBestDefinitionLocation,
  resolvePairedFileNavigation,
  resolveUeNavigationTarget,
} from './symbolNavigation';

export interface NavigationRuntime {
  project?: UEProject;
  engineRoot?: string;
}

type RuntimeGetter = () => NavigationRuntime | undefined;

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
  runtime: NavigationRuntime | undefined,
  mode: 'definition' | 'implementation' = 'definition',
): Promise<vscode.Location | undefined> {
  if (!symbol) return undefined;

  if (symbol.word === 'StaticClass') {
    return resolveUeNavigationTarget(document, position, {
      project: runtime?.project,
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

function pickOptions(document: vscode.TextDocument, runtime: NavigationRuntime | undefined) {
  return {
    projectRoot: runtime?.project?.projectRoot,
    pairedFilePath: findPairedSourceFile(document.fileName),
    engineRoot: runtime?.engineRoot,
  };
}

export async function goToDefinition(getRuntime: RuntimeGetter): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'cpp') {
    await vscode.commands.executeCommand('editor.action.revealDefinition');
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const symbol = getSymbolAtPosition(document, position);
  const runtime = getRuntime();

  if (symbol && isUhtMacroToken(symbol.word)) {
    vscode.window.showInformationMessage(
      'UE5_8 Cursor: UHT macros are IDE stubs. Use F12 on the function name.',
    );
    return;
  }

  const priorityUe = await resolvePriorityUeLocation(document, position, symbol, runtime);
  if (priorityUe) {
    await openLocation(priorityUe);
    return;
  }

  const filtered = await collectFilteredClangdDefinitions(document, position);
  const clangdBest = pickBestDefinitionLocation(filtered, document, symbol?.word, pickOptions(document, runtime));
  if (clangdBest) {
    await openLocation(clangdBest);
    return;
  }

  const ueLocation = await resolveUeNavigationTarget(document, position, {
    project: runtime?.project,
    mode: 'definition',
  });
  if (ueLocation) {
    await openLocation(ueLocation);
    return;
  }

  vscode.window.showWarningMessage('UE5_8 Cursor: Definition not found.');
}

export async function goToImplementation(getRuntime: RuntimeGetter): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'cpp') {
    await vscode.commands.executeCommand('editor.action.goToImplementation');
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const symbol = getSymbolAtPosition(document, position);
  const runtime = getRuntime();

  if (symbol && isUhtMacroToken(symbol.word)) {
    vscode.window.showInformationMessage(
      'UE5_8 Cursor: UHT macros are IDE stubs. Use Ctrl+F12 on the function name.',
    );
    return;
  }

  const priorityUe = await resolvePriorityUeLocation(document, position, symbol, runtime, 'implementation');
  if (priorityUe) {
    await openLocation(priorityUe);
    return;
  }

  const raw = await vscode.commands.executeCommand<
    vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
  >('vscode.executeImplementationProvider', document.uri, position);
  const filtered = filterStubLocations(normalizeDefinitionLocations(raw));
  const clangdBest = pickBestDefinitionLocation(filtered, document, symbol?.word, pickOptions(document, runtime));
  if (clangdBest) {
    await openLocation(clangdBest);
    return;
  }

  const ueLocation = await resolveUeNavigationTarget(document, position, {
    project: runtime?.project,
    mode: 'implementation',
  });
  if (ueLocation) {
    await openLocation(ueLocation);
    return;
  }

  vscode.window.showWarningMessage('UE5_8 Cursor: Implementation not found.');
}

export async function goToReferences(getRuntime: RuntimeGetter, moduleScan = true): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.commands.executeCommand('editor.action.goToReferences');
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const runtime = getRuntime();

  const ueRefs = findUeReferences(document, position, {
    projectRoot: runtime?.project?.projectRoot,
    moduleScan,
  });

  const clangdRaw = await vscode.commands.executeCommand<
    vscode.Location | vscode.Location[] | undefined
  >('vscode.executeReferenceProvider', document.uri, position);
  const clangdRefs = filterStubLocations(
    Array.isArray(clangdRaw) ? clangdRaw : clangdRaw ? [clangdRaw] : [],
  );

  const merged: vscode.Location[] = [];
  const seen = new Set<string>();
  for (const loc of [...ueRefs, ...clangdRefs]) {
    const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(loc);
  }

  if (merged.length > 0) {
    if (merged.length === 1) {
      await openLocation(merged[0]);
      return;
    }
    const items = merged.map((loc) => ({
      label: path.basename(loc.uri.fsPath),
      description: loc.uri.fsPath,
      location: loc,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'References' });
    if (picked) await openLocation(picked.location);
    return;
  }

  vscode.window.showWarningMessage('UE5_8 Cursor: References not found.');
}

export function registerUeNavigationCommands(
  context: vscode.ExtensionContext,
  getRuntime: RuntimeGetter,
  options?: { moduleReferenceScan?: () => boolean },
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GoToDefinition, () => goToDefinition(getRuntime)),
    vscode.commands.registerCommand(Commands.GoToImplementation, () => goToImplementation(getRuntime)),
    vscode.commands.registerCommand(Commands.GoToReferences, () =>
      goToReferences(getRuntime, options?.moduleReferenceScan?.() ?? true),
    ),
  );
}
