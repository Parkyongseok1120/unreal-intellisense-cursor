import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const provider = loadTsModule('src/uht/uhtCodeActionProvider.ts', {
  vscode: () => ({
    CodeActionKind: { QuickFix: 'quickfix' },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    CodeAction: class {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
        this.diagnostics = [];
        this.isPreferred = false;
        this.edit = undefined;
      }
    },
    WorkspaceEdit: class {
      constructor() {
        this.ops = [];
      }
      insert() {}
    },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    languages: {
      createDiagnosticCollection: () => ({
        get: () => [],
      }),
    },
  }),
  './uhtRunner': () => ({
    suggestedQuickFixes: (diag) => {
      const fixes = [];
      if (/GENERATED_BODY/i.test(diag.message)) fixes.push('Verify GENERATED_BODY() placement');
      if (/UFUNCTION/i.test(diag.message)) fixes.push('Add missing UFUNCTION() macro');
      if (/Implementation/i.test(diag.message)) fixes.push('Generate _Implementation stub');
      return fixes;
    },
  }),
  './uhtDiagnostics': () => ({
    ensureUhtDiagnosticCollection: () => ({
      get: () => [],
    }),
  }),
});

describe('uht code actions', () => {
  it('rejects Implementation quick fixes as unsafe', () => {
    assert.equal(provider.isSafeQuickFix('Generate _Implementation stub'), false);
    assert.equal(provider.isSafeQuickFix('Verify GENERATED_BODY() placement'), true);
    assert.equal(provider.isSafeQuickFix('Add missing UFUNCTION() macro'), true);
  });

  it('does not offer Implementation actions from provider', () => {
    const doc = {
      uri: { fsPath: 'C:/P/Foo.h' },
      lineAt: (line) => ({ text: line === 1 ? 'void Foo();' : '' }),
    };
    const range = { start: { line: 1, character: 0 } };
    const diag = {
      source: 'UHT',
      message: 'BlueprintNativeEvent must have _Implementation',
      severity: 0,
      code: 'UHT001',
    };
    const actions = new provider.UhtCodeActionProvider().provideCodeActions(
      doc,
      range,
      { diagnostics: [diag] },
    );
    assert.equal(actions.length, 0);
  });
});
