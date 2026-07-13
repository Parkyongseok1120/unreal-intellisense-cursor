import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function makeFixture(root) {
  const header = path.join(root, 'Source', 'Game', 'Public', 'Game.h');
  const source = path.join(root, 'Source', 'Game', 'Private', 'Game.cpp');
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    header,
    [
      'UCLASS()',
      'class AGame : public AActor',
      '{',
      '  GENERATED_BODY()',
      'public:',
      '  UFUNCTION(BlueprintCallable)',
      '  void TickMe();',
      '  int Score = 0;',
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    source,
    [
      '#include "Game.h"',
      'void AGame::TickMe()',
      '{',
      '  Score++;',
      '  GetWorld()->DoSomething();',
      '}',
    ].join('\n') + '\n',
  );
  return { header, source };
}

function mockDocument(filePath, position) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const lineText = lines[position.line] ?? '';
  const ident = /[A-Za-z_][A-Za-z0-9_]*/g;
  let word = '';
  let wordStart = position.character;
  let match;
  while ((match = ident.exec(lineText))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      word = match[0];
      wordStart = start;
      break;
    }
  }
  if (!word) {
    const tail = lineText.slice(position.character).match(/[A-Za-z_][A-Za-z0-9_]*/);
    if (tail) {
      word = tail[0];
      wordStart = position.character;
    }
  }

  return {
    fileName: filePath,
    languageId: 'cpp',
    uri: { fsPath: filePath },
    getText: (range) => {
      if (!range) return text;
      if (range.start && range.end) {
        if (range.start.line === range.end.line) {
          return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
        }
      }
      if (range.start) {
        const line = lines[range.start.line] ?? '';
        return line.slice(range.start.character, range.start.character + (range.end?.character ?? line.length));
      }
      return text;
    },
    lineAt: (line) => ({ text: lines[line] ?? '' }),
    lineCount: lines.length,
    getWordRangeAtPosition: () =>
      word
        ? {
            start: { line: position.line, character: wordStart },
            end: { line: position.line, character: wordStart + word.length },
          }
        : undefined,
  };
}

function loadUeNavigationCommands(vscodeMock, pairedResolver) {
  const stubPaths = loadTsModule('src/navigation/stubPaths.ts', {
    vscode: () => vscodeMock,
    '../constants': () => ({
      EXTENSION_DATA_DIR: '.ue5_8cursor',
      EXTENSION_DATA_DIR_LEGACY: '.ue58rider',
    }),
  });
  const symbolNavigation = loadTsModule('src/navigation/symbolNavigation.ts', {
    vscode: () => vscodeMock,
    '../parsers/moduleLayout': () => ({ findPairedSourceFile: pairedResolver }),
    '../uht/generatedHeaderParser': () => ({
      parseHeaderUFunctions: (content) => {
        const funcs = [];
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes('UFUNCTION')) continue;
          const next = lines[i + 1] ?? '';
          const m = next.match(/^\s*[\w:<>,\s*&]+\s+(\w+)\s*\(/);
          if (m) funcs.push({ name: m[1], line: i + 2 });
        }
        return funcs;
      },
    }),
    '../semantic/semanticService': () => ({
      getOrBuildSemanticGraph: async () => ({ symbols: [], modules: [], reflection: [], generatedArtifacts: [] }),
      querySymbol: () => undefined,
      findGeneratedPair: () => undefined,
    }),
    './stubPaths': () => stubPaths,
  });

  return loadTsModule('src/navigation/ueNavigationCommands.ts', {
    vscode: () => vscodeMock,
    '../constants': () => ({ Commands: { GoToDefinition: 'go', GoToImplementation: 'impl' } }),
    '../parsers/moduleLayout': () => ({ findPairedSourceFile: pairedResolver }),
    './symbolNavigation': () => symbolNavigation,
    './stubPaths': () => stubPaths,
  });
}

function pairedResolver(currentPath) {
  const ext = path.extname(currentPath).toLowerCase();
  const base = path.basename(currentPath, ext);
  const dir = path.dirname(currentPath);
  if (ext === '.h') return path.join(dir, '..', 'Private', `${base}.cpp`);
  if (ext === '.cpp') return path.join(dir, '..', 'Public', `${base}.h`);
  return undefined;
}

describe('ue navigation command orchestration', () => {
  it('goToDefinition uses priority paired navigation before clangd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-cmd-'));
    const { header, source } = makeFixture(root);
    const position = { line: 6, character: 8 };
    const doc = mockDocument(header, position);

    const opened = [];
    const commands = [];
    const vscodeMock = {
      Uri: { file: (p) => ({ fsPath: p }) },
      Location: class {
        constructor(uri, range) {
          this.uri = uri;
          this.range = range;
        }
      },
      Range: class {
        constructor(start, end) {
          this.start = start;
          this.end = end;
        }
      },
      Position: class {
        constructor(line, character) {
          this.line = line;
          this.character = character;
        }
      },
      window: {
        activeTextEditor: {
          document: doc,
          selection: { active: position },
        },
        showTextDocument: async (openedDoc, opts) => {
          opened.push({ path: openedDoc.uri?.fsPath ?? openedDoc.fileName, opts });
          return { revealRange: () => {} };
        },
        showInformationMessage: () => {},
        showWarningMessage: () => {},
      },
      workspace: {
        openTextDocument: async (uri) => ({ uri }),
      },
      commands: {
        executeCommand: async (cmd) => {
          commands.push(cmd);
          if (cmd === 'vscode.executeDefinitionProvider') {
            return [{ uri: { fsPath: 'C:/UE/Engine/Source/Runtime/Engine/Classes/Engine/World.h' }, range: { start: { line: 0, character: 0 } } }];
          }
          return undefined;
        },
      },
    };

    const ueNav = loadUeNavigationCommands(vscodeMock, pairedResolver);
    await ueNav.goToDefinition(() => undefined);

    assert.equal(commands.length, 0, 'clangd should not run when priority paired navigation succeeds');
    assert.equal(opened.length, 1);
    assert.ok(opened[0].path.endsWith('Game.cpp'));
    assert.equal(path.normalize(opened[0].path), path.normalize(source));
  });

  it('goToDefinition falls through to clangd when priority misses engine API', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-cmd-engine-'));
    const { source } = makeFixture(root);
    const position = { line: 4, character: 3 };
    const doc = mockDocument(source, position);

    const opened = [];
    const commands = [];
    const engineLoc = {
      uri: { fsPath: 'C:/UE/Engine/Source/Runtime/Engine/Classes/Engine/World.h' },
      range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } },
    };
    const vscodeMock = {
      Uri: { file: (p) => ({ fsPath: p }) },
      Location: class {
        constructor(uri, range) {
          this.uri = uri;
          this.range = range;
        }
      },
      Range: class {
        constructor(start, end) {
          this.start = start;
          this.end = end;
        }
      },
      Position: class {
        constructor(line, character) {
          this.line = line;
          this.character = character;
        }
      },
      window: {
        activeTextEditor: {
          document: doc,
          selection: { active: position },
        },
        showTextDocument: async (openedDoc) => {
          opened.push(openedDoc.uri?.fsPath);
          return { revealRange: () => {} };
        },
        showInformationMessage: () => {},
        showWarningMessage: () => {},
      },
      workspace: {
        openTextDocument: async (uri) => ({ uri }),
      },
      commands: {
        executeCommand: async (cmd) => {
          commands.push(cmd);
          if (cmd === 'vscode.executeDefinitionProvider') return [engineLoc];
          return undefined;
        },
      },
    };

    const ueNav = loadUeNavigationCommands(vscodeMock, pairedResolver);
    await ueNav.goToDefinition(() => undefined);

    assert.ok(commands.includes('vscode.executeDefinitionProvider'));
    assert.equal(opened.length, 1);
    assert.ok(opened[0].includes('Engine'));
  });

  it('goToImplementation blocks UHT macro tokens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-cmd-macro-'));
    const { header } = makeFixture(root);
    const position = { line: 5, character: 2 };
    const doc = mockDocument(header, position);

    let infoMessage = '';
    const vscodeMock = {
      Uri: { file: (p) => ({ fsPath: p }) },
      Location: class {
        constructor(uri, range) {
          this.uri = uri;
          this.range = range;
        }
      },
      Range: class {
        constructor(start, end) {
          this.start = start;
          this.end = end;
        }
      },
      Position: class {
        constructor(line, character) {
          this.line = line;
          this.character = character;
        }
      },
      window: {
        activeTextEditor: {
          document: doc,
          selection: { active: position },
        },
        showTextDocument: async () => ({ revealRange: () => {} }),
        showInformationMessage: (msg) => {
          infoMessage = msg;
        },
        showWarningMessage: () => {},
      },
      workspace: { openTextDocument: async (uri) => ({ uri }) },
      commands: { executeCommand: async () => undefined },
    };

    const ueNav = loadUeNavigationCommands(vscodeMock, () => undefined);
    await ueNav.goToImplementation(() => undefined);
    assert.ok(infoMessage.includes('UHT'));
  });
});
