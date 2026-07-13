import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const impl = loadTsModule('src/navigation/implementationCodeAction.ts', {
  vscode: () => ({
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    },
    WorkspaceEdit: class {
      insert() {}
    },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class {},
    Uri: { file: (p) => ({ fsPath: p }) },
  }),
  '../parsers/moduleLayout': () => ({
    findPairedSourceFile: () => 'C:/Proj/Source/Game/Private/Foo.cpp',
  }),
  './symbolNavigation': () => ({
    findEnclosingUeClass: () => 'AFoo',
    isHeaderMethodDeclarationLine: () => true,
    isUfunctionMethodContext: () => false,
  }),
  './implementationHelpers': () => ({
    methodImplementationExists: () => false,
  }),
  fs: () => ({
    readFileSync: () => '#include "Foo.generated.h"\n\nvoid AFoo::Bar() {}\n',
  }),
});

describe('implementation code action', () => {
  it('builds native method stub', () => {
    const stub = impl.buildImplementationStub({
      headerPath: 'C:/Proj/Source/Game/Public/Foo.h',
      className: 'AFoo',
      methodName: 'Bar',
      declarationLine: 'void Bar();',
      isBlueprintNativeEvent: false,
    });
    assert.match(stub, /AFoo::Bar\(\)/);
  });

  it('builds BlueprintNativeEvent _Implementation stub', () => {
    const stub = impl.buildImplementationStub({
      headerPath: 'C:/Proj/Source/Game/Public/Foo.h',
      className: 'AFoo',
      methodName: 'Baz',
      declarationLine: 'virtual void Baz() override;',
      isBlueprintNativeEvent: true,
    });
    assert.match(stub, /AFoo::Baz_Implementation\(/);
  });
});
