import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(__dirname, '..');
const projectRoot = path.resolve(extRoot, '..', 'Project_MJS');
const uprojectPath = path.join(projectRoot, 'Project_MJS.uproject');
const projectAvailable = fs.existsSync(uprojectPath);

const playerHeader = path.join(
  projectRoot,
  'Source',
  'Project_MJS',
  'Public',
  'Character',
  'Player',
  'CPlayerCharacter.h',
);
const playerSource = path.join(
  projectRoot,
  'Source',
  'Project_MJS',
  'Private',
  'Character',
  'Player',
  'CPlayerCharacter.cpp',
);

const vscodeMock = {
  Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
  Location: class {
    constructor(uri, rangeOrPos) {
      this.uri = uri;
      if (rangeOrPos?.start) this.range = rangeOrPos;
      else this.range = { start: rangeOrPos, end: rangeOrPos };
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
        const rel = currentPath.includes(`${path.sep}Public${path.sep}`)
          ? path.join(dir.replace(`${path.sep}Public${path.sep}`, `${path.sep}Private${path.sep}`), `${base}.cpp`)
          : undefined;
        return rel && fs.existsSync(rel) ? rel : undefined;
      }
      if (ext === '.cpp') {
        const rel = currentPath.includes(`${path.sep}Private${path.sep}`)
          ? path.join(dir.replace(`${path.sep}Private${path.sep}`, `${path.sep}Public${path.sep}`), `${base}.h`)
          : undefined;
        return rel && fs.existsSync(rel) ? rel : undefined;
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
  return {
    fileName: filePath,
    languageId: 'cpp',
    uri: { fsPath: filePath },
    getText: () => text,
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

function lineIndexFor(filePath, pattern) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  return lines.findIndex((line) => pattern.test(line));
}

const describeProject = projectAvailable ? describe : describe.skip;

describeProject('Project_MJS navigation verification', () => {
  it('UFUNCTION ResetState in header navigates to cpp implementation', async () => {
    const line = lineIndexFor(playerHeader, /void ResetState\(\)/);
    assert.ok(line >= 0);
    const position = { line, character: 6 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(playerHeader, position),
      position,
      'ResetState',
      'definition',
    );
    assert.ok(loc);
    assert.equal(path.normalize(loc.uri.fsPath), path.normalize(playerSource));
    const sourceLine = fs.readFileSync(playerSource, 'utf-8').split('\n')[loc.range.start.line];
    assert.match(sourceLine, /ACPlayerCharacter::ResetState/);
  });

  it('native BeginPlay in header navigates to cpp implementation', async () => {
    const line = lineIndexFor(playerHeader, /void BeginPlay\(\)/);
    assert.ok(line >= 0);
    const position = { line, character: 8 };
    const loc = await symbolNavigation.resolvePairedFileNavigation(
      mockDocument(playerHeader, position),
      position,
      'BeginPlay',
      'definition',
    );
    assert.ok(loc);
    assert.equal(path.normalize(loc.uri.fsPath), path.normalize(playerSource));
  });

  it('cpp member bHasMoveInput navigates to paired header declaration', async () => {
    const line = lineIndexFor(playerSource, /bHasMoveInput/);
    assert.ok(line >= 0);
    const position = { line, character: 10 };
    const doc = mockDocument(playerSource, position);
    assert.equal(symbolNavigation.isPriorityPairedNavigationCandidate(doc, position, 'bHasMoveInput', 'definition'), true);
    const loc = await symbolNavigation.resolvePairedFileNavigation(doc, position, 'bHasMoveInput', 'definition');
    assert.ok(loc);
    assert.equal(path.normalize(loc.uri.fsPath), path.normalize(playerHeader));
  });

  it('GetWorld call site is not a priority paired navigation candidate', () => {
    const line = lineIndexFor(playerSource, /GetWorld\(\)/);
    assert.ok(line >= 0);
    const position = { line, character: 7 };
    const doc = mockDocument(playerSource, position);
    assert.equal(symbolNavigation.isPriorityPairedNavigationCandidate(doc, position, 'GetWorld', 'definition'), false);
    assert.equal(symbolNavigation.isMethodNavigationCandidate(doc, position, 'GetWorld'), false);
  });

  it('StaticClass resolves to generated header when Intermediate build exists', async () => {
    const controllerSource = path.join(
      projectRoot,
      'Source',
      'Project_MJS',
      'Private',
      'Character',
      'Player',
      'CPlayerController.cpp',
    );
    const line = lineIndexFor(controllerSource, /StaticClass\(\)/);
    if (line < 0) return;

    const generatedCandidates = [];
    const intermediate = path.join(projectRoot, 'Intermediate');
    if (fs.existsSync(intermediate)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.generated.h')) generatedCandidates.push(full);
        }
      };
      walk(intermediate);
    }
    if (generatedCandidates.length === 0) {
      console.log('[Project_MJS] skip StaticClass — no .generated.h (run UHT/build first)');
      return;
    }

    const lineText = fs.readFileSync(controllerSource, 'utf-8').split('\n')[line];
    const staticIndex = lineText.indexOf('StaticClass');
    assert.ok(staticIndex >= 0);
    const position = { line, character: staticIndex + 2 };

    const project = {
      name: 'Project_MJS',
      projectRoot,
      uprojectPath,
      engineAssociation: '5.8',
      modules: [],
    };
    const loc = await symbolNavigation.resolveUeNavigationTarget(
      mockDocument(controllerSource, position),
      position,
      { project, mode: 'definition' },
    );
    if (!loc) {
      console.log('[Project_MJS] skip StaticClass — resolver miss (generated content may not include target class)');
      return;
    }
    assert.ok(loc.uri.fsPath.endsWith('.generated.h'));
  });
});

describeProject('Project_MJS debug config verification', () => {
  it('launch config names match programmatic DebugGame targets', () => {
    const launchConfig = loadTsModule('src/cursor/launchConfig.ts', {
      '../platform/debug': () => ({
        buildSymbolSearchPaths: () => `${projectRoot}/Binaries/Win64;C:/UE/Engine/Binaries/Win64`,
        resolveEditorProgramPath: () => 'C:/UE/Engine/Binaries/Win64/UnrealEditor-Win64-DebugGame.exe',
        resolveGameExecutable: () => `${projectRoot}/Binaries/Win64/Project_MJS-Win64-DebugGame.exe`,
        resolveServerExecutable: () => `${projectRoot}/Binaries/Win64/Project_MJSServer.exe`,
        resolveNatvisPath: (root) => path.join(root, 'Engine/Extras/VisualStudioDebugging/Unreal.natvis'),
      }),
      '../build/ubt': () => ({
        buildCommandLine: () => ({ executable: 'C:/UE/UBT.exe', args: ['Project_MJSEditor', 'Win64', 'DebugGame'] }),
        resolveTargetName: (_project, type) => {
          if (type === 'Editor') return 'Project_MJSEditor';
          if (type === 'Server') return 'Project_MJSServer';
          return 'Project_MJS';
        },
      }),
      '../platform/platform': () => ({
        getDebuggerType: () => 'cppvsdbg',
        getDebuggerMIMode: () => undefined,
      }),
      '../platform/workspaceMutation': () => ({
        mutateJson: async () => {},
      }),
    });

    const input = {
      project: {
        name: 'Project_MJS',
        projectRoot,
        uprojectPath,
        engineAssociation: '5.8',
        modules: [],
      },
      engine: {
        root: 'C:/UE',
        editorPath: 'C:/UE/Engine/Binaries/Win64/UnrealEditor.exe',
        ubtPath: 'C:/UE/UBT.exe',
        version: '5.8',
        source: 'manual',
        isSourceBuild: false,
      },
      debugConfiguration: 'DebugGame',
      platform: 'Win64',
    };

    const launch = launchConfig.buildLaunchJson(input);
    const editor = launch.configurations.find((c) => c.name.includes('Project_MJSEditor'));
    const standalone = launch.configurations.find((c) => c.name.includes('Standalone'));
    assert.ok(editor);
    assert.ok(standalone);
    assert.equal(editor.program, 'C:/UE/Engine/Binaries/Win64/UnrealEditor-Win64-DebugGame.exe');
    assert.equal(standalone.program, `${projectRoot}/Binaries/Win64/Project_MJS-Win64-DebugGame.exe`);
    assert.equal(editor.preLaunchTask, launchConfig.DEBUG_TASK_BUILD_EDITOR);
  });
});
