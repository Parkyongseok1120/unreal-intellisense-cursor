import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const vscodeStub = {
  tests: {
    createTestController: () => ({
      items: { replace: () => {}, add: () => {}, get: () => undefined, [Symbol.iterator]: function* () {} },
      createTestItem: () => ({ children: { add: () => {}, [Symbol.iterator]: function* () {} } }),
      createTestRun: () => ({ started: () => {}, passed: () => {}, failed: () => {}, errored: () => {}, skipped: () => {}, appendOutput: () => {}, end: () => {} }),
      createRunProfile: () => ({ runHandler: async () => {} }),
      resolveHandler: undefined,
      dispose: () => {},
    }),
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  EventEmitter: class {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
  },
  TestRunProfileKind: { Run: 1, Debug: 2 },
  Uri: { file: (p) => ({ fsPath: p }), parse: (p) => ({ fsPath: p }) },
  CancellationTokenSource: class { token = { isCancellationRequested: false }; },
};

const explorerModule = loadTsModule('src/testing/unrealTestExplorer.ts', {
  vscode: () => vscodeStub,
  '../editorBridge/bridgeProtocol': () => ({ isMethodImplemented: () => true }),
});

describe('unreal test explorer helpers', () => {
  it('parses full automation test name from nested item id', () => {
    assert.equal(
      explorerModule.automationTestNameFromId('automation:Project.Smoke.Basic'),
      'Project.Smoke.Basic',
    );
    assert.equal(explorerModule.automationTestNameFromId('spec:MySpec.Case'), 'MySpec.Case');
  });

  it('rejects suite ids', () => {
    assert.equal(explorerModule.automationTestNameFromId('automation:suite:Project.Smoke'), undefined);
    assert.equal(explorerModule.isRunnableAutomationTestId('automation:suite:Project.Smoke'), false);
  });

  it('accepts runnable leaf ids', () => {
    assert.equal(explorerModule.isRunnableAutomationTestId('automation:Project.Smoke.Basic'), true);
  });
});
