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
