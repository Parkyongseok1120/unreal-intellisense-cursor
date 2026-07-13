import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const vscodeMock = {
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => p }),
  },
  Location: class {
    constructor(uri, rangeOrPos) {
      this.uri = uri;
      if (rangeOrPos?.start) {
        this.range = rangeOrPos;
      } else {
        this.range = { start: rangeOrPos, end: rangeOrPos };
      }
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
};

const stubPaths = loadTsModule('src/navigation/stubPaths.ts', {
  vscode: () => vscodeMock,
  '../constants': () => ({
    EXTENSION_DATA_DIR: '.ue5_8cursor',
    EXTENSION_DATA_DIR_LEGACY: '.ue58rider',
  }),
});

const symbolNavigation = loadTsModule('src/navigation/symbolNavigation.ts', {
  vscode: () => vscodeMock,
  '../parsers/moduleLayout': () => ({
    findPairedSourceFile: (currentPath) => {
      const ext = path.extname(currentPath).toLowerCase();
      const base = path.basename(currentPath, ext);
      const dir = path.dirname(currentPath);
      if (ext === '.h') {
        const cpp = path.join(dir, '..', 'Private', `${base}.cpp`);
        return fs.existsSync(cpp) ? cpp : undefined;
      }
      if (ext === '.cpp') {
        const header = path.join(dir, '..', 'Public', `${base}.h`);
        return fs.existsSync(header) ? header : undefined;
      }
      return undefined;
    },
  }),
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
    getWordRangeAtPosition: () => {
      if (!word) return undefined;
      return {
        start: { line: position.line, character: wordStart },
        end: { line: position.line, character: wordStart + word.length },
      };
    },
  };
}

function makeFixture(root) {
  const header = path.join(root, 'Source', 'Game', 'Public', 'Game.h');
  const source = path.join(root, 'Source', 'Game', 'Private', 'Game.cpp');
  const generated = path.join(
    root,
    'Intermediate',
    'Build',
    'Win64',
    'x64',
    'UnrealEditor',
    'Development',
    'Game',
    'Game.generated.h',
  );
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(generated), { recursive: true });
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
      '};',
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    source,
    [
      '#include "Game.h"',
      'void AGame::TickMe()',
      '{',
      '}',
      'void AGame::StaticClassCall()',
      '{',
      '  AGame::StaticClass();',
      '}',
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    generated,
    ['class AGame;', 'UClass* AGame::StaticClass()', '{ return nullptr; }'].join('\n') + '\n',
  );
  return { header, source, generated, root };
}

describe('navigation stub paths', () => {
  it('detects UHTIDEStubs paths', () => {
    assert.equal(stubPaths.isUhtStubPath('C:/Proj/.ue5_8cursor/UHTIDEStubs.h'), true);
    assert.equal(stubPaths.isUhtStubPath('C:/Proj/.ue58rider/UHTIDEStubs.h'), true);
    assert.equal(stubPaths.isUhtStubPath('C:/Proj/Source/Game/Private/Game.cpp'), false);
  });

  it('filters stub locations only', () => {
    const locations = [
      { uri: { fsPath: 'C:/P/.ue5_8cursor/UHTIDEStubs.h' }, range: { start: { line: 1, character: 0 } } },
      { uri: { fsPath: 'C:/P/Source/Game/Private/Game.cpp' }, range: { start: { line: 2, character: 0 } } },
    ];
    const filtered = stubPaths.filterStubLocations(locations);
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].uri.fsPath.endsWith('Game.cpp'));
  });

  it('treats UHT macro tokens as non-navigable', () => {
    assert.equal(stubPaths.isUhtMacroToken('UFUNCTION'), true);
    assert.equal(stubPaths.isUhtMacroToken('TickMe'), false);
  });
});

describe('symbol navigation resolver', () => {
  it('resolves UFUNCTION method from header to cpp implementation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-'));
    const { header, source } = makeFixture(root);
    const position = { line: 6, character: 8 };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(header, position),
      position,
      { mode: 'definition' },
    );
    assert.ok(loc);
    assert.ok(loc.uri.fsPath.endsWith('Game.cpp'));
    const sourceLine = fs.readFileSync(source, 'utf-8').split('\n')[loc.range.start.line];
    assert.match(sourceLine, /AGame::TickMe/);
  });

  it('resolves cpp implementation back to header declaration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-back-'));
    const { header, source } = makeFixture(root);
    const position = { line: 1, character: 12 };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(source, position),
      position,
      { mode: 'definition' },
    );
    assert.ok(loc);
    assert.ok(loc.uri.fsPath.endsWith('Game.h'));
    const headerLine = fs.readFileSync(header, 'utf-8').split('\n')[loc.range.start.line];
    assert.match(headerLine, /TickMe/);
  });

  it('routes StaticClass to generated header', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-static-'));
    const { source, generated, root: projectRoot } = makeFixture(root);
    const project = {
      name: 'Game',
      projectRoot,
      uprojectPath: path.join(projectRoot, 'Game.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    const position = { line: 6, character: 16 };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(source, position),
      position,
      { project, mode: 'definition' },
    );
    assert.ok(loc);
    assert.equal(path.normalize(loc.uri.fsPath), path.normalize(generated));
  });

  it('returns undefined for UFUNCTION macro keyword', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-macro-'));
    const { header } = makeFixture(root);
    const position = { line: 5, character: 2 };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(header, position),
      position,
      { mode: 'definition' },
    );
    assert.equal(loc, undefined);
  });

  it('does not treat unrelated identifiers as method navigation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-unrelated-'));
    const { source } = makeFixture(root);
    const position = { line: 3, character: 8 };
    const doc = mockDocument(source, position);
    assert.equal(symbolNavigation.isMethodNavigationCandidate(doc, position, 'nullptr'), false);
    assert.equal(symbolNavigation.isUeClassTypeSymbol('AActor'), true);
    assert.equal(symbolNavigation.isUeClassTypeSymbol('GetWorld'), false);
    assert.equal(symbolNavigation.isUeClassTypeSymbol('Event'), false);
  });

  it('implementation mode from header does not fall back to declaration without cpp', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-impl-only-'));
    const { header } = makeFixture(root);
    fs.writeFileSync(
      header,
      [
        'UCLASS()',
        'class AGame : public AActor',
        '{',
        '  GENERATED_BODY()',
        'public:',
        '  virtual void BeginPlay() override;',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(root, 'Source', 'Game', 'Private', 'Game.cpp'), '#include "Game.h"\n');
    const position = { line: 5, character: 16 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(header, position),
      position,
      'BeginPlay',
      'implementation',
    );
    assert.equal(loc, undefined);
  });

  it('priority candidate rejects engine API call sites in cpp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-priority-'));
    const { source } = makeFixture(root);
    const callSiteCpp = [
      '#include "Game.h"',
      'void AGame::TickMe()',
      '{',
      '  GetWorld()->DoSomething();',
      '}',
    ].join('\n') + '\n';
    fs.writeFileSync(source, callSiteCpp);
    const position = { line: 3, character: 3 };
    const doc = mockDocument(source, position);
    assert.equal(symbolNavigation.isPriorityPairedNavigationCandidate(doc, position, 'GetWorld', 'definition'), false);
  });

  it('does not treat engine API call sites in cpp as method navigation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-call-'));
    const { source } = makeFixture(root);
    const callSiteCpp = [
      '#include "Game.h"',
      'void AGame::TickMe()',
      '{',
      '  GetWorld()->DoSomething();',
      '}',
    ].join('\n') + '\n';
    fs.writeFileSync(source, callSiteCpp);
    const position = { line: 3, character: 3 };
    const doc = mockDocument(source, position);
    assert.equal(symbolNavigation.isMethodNavigationCandidate(doc, position, 'GetWorld'), false);
  });

  it('does not resolve StaticClass to unrelated generated class body', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-static-wrong-'));
    const { source, root: projectRoot } = makeFixture(root);
    const otherGenerated = path.join(
      root,
      'Intermediate',
      'Build',
      'Win64',
      'x64',
      'UnrealEditor',
      'Development',
      'Game',
      'Other.generated.h',
    );
    fs.writeFileSync(
      otherGenerated,
      ['class AOther;', 'UClass* AOther::StaticClass()', '{ return nullptr; }'].join('\n') + '\n',
    );
    const project = {
      name: 'Game',
      projectRoot,
      uprojectPath: path.join(projectRoot, 'Game.uproject'),
      engineAssociation: '5.8',
      modules: [],
    };
    const position = { line: 6, character: 16 };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(source, position),
      position,
      { project, mode: 'definition' },
    );
    assert.ok(loc);
    assert.ok(loc.uri.fsPath.endsWith('Game.generated.h'));
    const line = fs.readFileSync(loc.uri.fsPath, 'utf-8').split('\n')[loc.range.start.line];
    assert.match(line, /AGame::StaticClass/);
  });

  it('resolves native header method declaration to cpp implementation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-native-'));
    const { header, source } = makeFixture(root);
    fs.writeFileSync(
      header,
      [
        'UCLASS()',
        'class AGame : public AActor',
        '{',
        '  GENERATED_BODY()',
        'public:',
        '  virtual void BeginPlay() override;',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      source,
      ['#include "Game.h"', 'void AGame::BeginPlay()', '{', '}'].join('\n') + '\n',
    );
    const position = { line: 5, character: 16 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(header, position),
      position,
      'BeginPlay',
      'definition',
    );
    assert.ok(loc);
    assert.ok(loc.uri.fsPath.endsWith('Game.cpp'));
  });

  it('resolves cpp member usage to paired header declaration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-member-'));
    const { header, source } = makeFixture(root);
    fs.writeFileSync(
      header,
      [
        'UCLASS()',
        'class AGame : public AActor',
        '{',
        '  GENERATED_BODY()',
        'public:',
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
        '}',
      ].join('\n') + '\n',
    );
    const position = { line: 3, character: 3 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(source, position),
      position,
      'Score',
      'definition',
    );
    assert.ok(loc);
    assert.ok(loc.uri.fsPath.endsWith('Game.h'));
    const headerLine = fs.readFileSync(header, 'utf-8').split('\n')[loc.range.start.line];
    assert.match(headerLine, /Score/);
  });

  it('prefers paired header over engine path when scoring clangd results', () => {
    const doc = {
      fileName: 'C:/Proj/Source/Game/Private/Game.cpp',
    };
    const pairedHeader = 'C:/Proj/Source/Game/Public/Game.h';
    const engineHeader = 'C:/UE/Engine/Source/Runtime/Engine/Classes/Game/Game.h';
    const locations = [
      { uri: { fsPath: engineHeader }, range: { start: { line: 1, character: 0 } } },
      { uri: { fsPath: pairedHeader }, range: { start: { line: 4, character: 0 } } },
    ];
    const best = symbolNavigation.pickBestDefinitionLocation(locations, doc, 'Score', {
      projectRoot: 'C:/Proj',
      pairedFilePath: pairedHeader,
    });
    assert.equal(best.uri.fsPath, pairedHeader);
  });

  it('does not hijack local variable names in cpp', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-local-'));
    const { source } = makeFixture(root);
    const localVarCpp = [
      '#include "Game.h"',
      'void AGame::TickMe()',
      '{',
      '  int Counter = 0;',
      '}',
    ].join('\n') + '\n';
    fs.writeFileSync(source, localVarCpp);
    const position = { line: 3, character: 7 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(source, position),
      position,
      'Counter',
      'definition',
    );
    assert.equal(loc, undefined);
  });

  it('finds enclosing class with module API export macro', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-nav-api-'));
    const header = path.join(root, 'Source', 'Game', 'Public', 'Game.h');
    fs.mkdirSync(path.dirname(header), { recursive: true });
    fs.writeFileSync(
      header,
      [
        'UCLASS()',
        'class GAME_API AGame : public AActor',
        '{',
        '  GENERATED_BODY()',
        'public:',
        '  void ResetState();',
      ].join('\n') + '\n',
    );
    const position = { line: 5, character: 8 };
    const doc = mockDocument(header, position);
    assert.equal(symbolNavigation.findEnclosingUeClass(doc, position.line), 'AGame');
  });

  it('does not penalize project Plugins/Runtime paths as engine sources', () => {
    const projectRoot = 'C:/Proj';
    const pluginRuntime = 'C:/Proj/Plugins/Runtime/MyPlugin/Source/Foo.h';
    assert.equal(symbolNavigation.isEngineSourcePath(pluginRuntime, projectRoot), false);
    const enginePath = 'C:/UE/Engine/Source/Runtime/Engine/Classes/Engine/World.h';
    assert.equal(symbolNavigation.isEngineSourcePath(enginePath, projectRoot, 'C:/UE'), true);
  });
});
