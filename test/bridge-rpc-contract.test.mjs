import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const clientSrc = fs.readFileSync(path.join(process.cwd(), 'src/editorBridge/editorBridgeClient.ts'), 'utf-8');
const cppSrc = fs.readFileSync(
  path.join(process.cwd(), 'plugins/UE58CursorBridge/Source/UE58CursorBridge/Private/CursorBridgeHttpServer.cpp'),
  'utf-8',
);

function extractMethodParams(tsSource, method) {
  const callRpc = new RegExp(`callRpc[^(]*\\(\\s*'${method}'[\\s\\S]*?\\{([^}]*)\\}`, 'm');
  const direct = new RegExp(`editorBridgeRpc\\([\\s\\S]*?'${method}'[\\s\\S]*?\\{([^}]*)\\}`, 'm');
  return tsSource.match(callRpc)?.[1] ?? tsSource.match(direct)?.[1] ?? '';
}

describe('bridge RPC param/response contract', () => {
  it('blueprint.findImplementations sends classPath', () => {
    const params = extractMethodParams(clientSrc, 'blueprint.findImplementations');
    assert.ok(params.includes('classPath'));
    assert.ok(cppSrc.includes('TEXT("blueprint.findImplementations")'));
  });

  it('blueprint.listDerived sends classPath', () => {
    const params = extractMethodParams(clientSrc, 'blueprint.listDerived');
    assert.ok(params.includes('classPath'));
    assert.ok(cppSrc.includes('TEXT("blueprint.listDerived")'));
  });

  it('assetRegistry.delta uses since and normalizes delta shape', () => {
    const params = extractMethodParams(clientSrc, 'assetRegistry.delta');
    assert.ok(params.includes('since'));
    assert.ok(clientSrc.includes('added: result.value.added ?? []'));
    assert.ok(clientSrc.includes('removed: result.value.removed ?? []'));
    assert.ok(clientSrc.includes('updated: result.value.updated ?? []'));
    assert.ok(cppSrc.includes('TEXT("assetRegistry.delta")'));
  });

  it('blueprint.propertyOverrides sends classPath and reads overrides array', () => {
    const params = extractMethodParams(clientSrc, 'blueprint.propertyOverrides');
    assert.ok(params.includes('classPath'));
    assert.ok(clientSrc.includes('result.value.overrides ?? []'));
  });

  it('assetRegistry.referencers sends path and depth', () => {
    const params = extractMethodParams(clientSrc, 'assetRegistry.referencers');
    assert.ok(params.includes('path'));
    assert.ok(params.includes('depth'));
    assert.ok(cppSrc.includes('TEXT("assetRegistry.referencers")'));
  });

  it('assetRegistry.dependencies sends path', () => {
    const params = extractMethodParams(clientSrc, 'assetRegistry.dependencies');
    assert.ok(params.includes('path'));
    assert.ok(cppSrc.includes('TEXT("assetRegistry.dependencies")'));
  });

  it('blueprint.findUFunctionNodes sends classPath and functionName', () => {
    const params = extractMethodParams(clientSrc, 'blueprint.findUFunctionNodes');
    assert.ok(params.includes('classPath'));
    assert.ok(params.includes('functionName'));
    assert.ok(clientSrc.includes('nodes: result.value.nodes ?? []'));
    assert.ok(cppSrc.includes('TEXT("blueprint.findUFunctionNodes")'));
  });

  it('automation.status reads duration line and artifact fields', () => {
    assert.ok(clientSrc.includes('durationMs'));
    assert.ok(clientSrc.includes('artifactPath'));
    assert.ok(cppSrc.includes('TEXT("automation.status")'));
    assert.ok(cppSrc.includes('durationMs'));
  });

  it('automation.run resets existing execution record', () => {
    assert.ok(cppSrc.includes('GAutomationTestStates.FindOrAdd(TestName)'));
    assert.ok(!cppSrc.includes('GAutomationTestStates.Add(TestName'));
  });
});
