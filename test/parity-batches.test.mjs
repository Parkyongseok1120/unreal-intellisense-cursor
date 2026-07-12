import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const root = process.cwd();

describe('bridge protocol codegen', () => {
  it('generated methods match schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'editor-bridge-v1.json'), 'utf-8'));
    const generated = loadTsModule('src/editorBridge/bridgeProtocol.generated.ts');
    const schemaMethods = Object.keys(schema.methods).sort();
    const genMethods = [...generated.GENERATED_BRIDGE_METHODS].sort();
    assert.deepEqual(genMethods, schemaMethods);
  });

  it('check --check passes without drift', () => {
    const r = spawnSync(process.execPath, ['scripts/generate-bridge-protocol.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
    assert.equal(r.status, 0, r.stderr?.toString() || r.stdout?.toString());
  });
});

describe('workspace project registry', () => {
  it('registry module exports ensure and dispose', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'session', 'workspaceProjectRegistry.ts'), 'utf-8');
    assert.ok(src.includes('ensure('));
    assert.ok(src.includes('disposeProject'));
    assert.ok(src.includes('getByUri'));
    assert.ok(src.includes('disposeUnder'));
    assert.ok(src.includes('b.length - a.length'));
  });
});

describe('Gate 2 project-scoped runtime state', () => {
  it('keeps watcher, UHT, bridge views, and log cursors project-keyed', () => {
    const read = (file) => fs.readFileSync(path.join(root, 'src', ...file.split('/')), 'utf-8');
    const watcher = read('detection/sourceWatcher.ts');
    const uht = read('uht/uhtValidation.ts');
    const content = read('assets/contentBrowserProvider.ts');
    const tests = read('testing/unrealTestExplorer.ts');
    const logs = read('logs/unrealLogViewer.ts');
    const extension = read('extension.ts');
    const commandBridge = read('mcp/commandBridge.ts');
    assert.ok(watcher.includes('resolveRuntime: (uri: vscode.Uri)'));
    assert.ok(watcher.includes('const states = new Map<string, PendingBatch>()'));
    assert.ok(uht.includes('const validationStates = new Map<string, ValidationState>()'));
    assert.ok(content.includes('private readonly states = new Map<string, ContentBrowserState>()'));
    assert.ok(tests.includes('private readonly runtimeStates = new Map<string, TestRuntimeState>()'));
    assert.ok(logs.includes('private readonly states = new Map<string, LogRuntimeState>()'));
    assert.ok(extension.includes('projectRuntime.session.ensureBridge(project.projectRoot)'));
    assert.ok(extension.includes('ue58rider.executeProjectBridgeCommand'));
    assert.ok(commandBridge.includes('projectRoot: this.projectRoot'));
  });
});

describe('fault injection artifact', () => {
  it('runs harness and writes artifact', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-fault-')), 'faults.json');
    const r = spawnSync(process.execPath, ['scripts/fault-injection.mjs'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, FAULT_INJECTION_PATH: out },
    });
    assert.equal(r.status, 0, r.stderr?.toString());
    const artifact = JSON.parse(fs.readFileSync(out, 'utf-8'));
    assert.ok(artifact.total >= 20);
    assert.ok(artifact.passed >= 20);
  });
});
