import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const generated = loadTsModule('src/editorBridge/bridgeProtocol.generated.ts');
const protocol = loadTsModule('src/editorBridge/bridgeProtocol.ts', {
  './bridgeProtocol.generated': () => generated,
});

function extractCppMethods(cppSource) {
  const methods = new Set();
  const re = /Method\s*==\s*TEXT\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(cppSource)) !== null) {
    methods.add(m[1]);
  }
  return methods;
}

describe('bridge protocol contract', () => {
  it('TS implemented methods are subset of declared BRIDGE_METHODS', () => {
    for (const method of protocol.BRIDGE_IMPLEMENTED_METHODS) {
      assert.ok(protocol.BRIDGE_METHODS.includes(method), `${method} missing from schema`);
    }
  });

  it('C++ server methods match TS implemented registry', () => {
    const cppPath = path.join(
      process.cwd(),
      'plugins',
      'UE58CursorBridge',
      'Source',
      'UE58CursorBridge',
      'Private',
      'CursorBridgeHttpServer.cpp',
    );
    const cppSource = fs.readFileSync(cppPath, 'utf-8');
    const cppMethods = extractCppMethods(cppSource);

    for (const method of protocol.CPP_BRIDGE_METHODS) {
      assert.ok(cppMethods.has(method), `C++ missing method ${method}`);
    }

    for (const method of protocol.BRIDGE_IMPLEMENTED_METHODS) {
      assert.ok(cppMethods.has(method), `C++ missing implemented method ${method}`);
    }
  });

  it('handshake capabilities only advertise implemented feature groups', () => {
    const caps = Object.keys(protocol.BRIDGE_CAPABILITIES);
    assert.ok(caps.includes('assetRegistry'));
    assert.ok(caps.includes('automationTests'));
    if (protocol.BRIDGE_IMPLEMENTED_METHODS.has('blueprint.listDerived')) {
      assert.ok(caps.includes('blueprintGraph'));
    }
  });

  it('no unknown-to-passed fallback in client poll', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/editorBridge/editorBridgeClient.ts'), 'utf-8');
    assert.ok(!src.includes("state ?? 'passed'"));
    assert.ok(!src.includes("|| 'passed'"));
    assert.ok(src.includes("result.state === 'passed'"));
  });
});
