import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const cppSrc = fs.readFileSync(
  path.join(process.cwd(), 'plugins/UE58CursorBridge/Source/UE58CursorBridge/Private/CursorBridgeHttpServer.cpp'),
  'utf-8',
);

describe('bridge C++ stability helpers', () => {
  it('strips A/U prefix in BlueprintClassMatchToken', () => {
    assert.ok(cppSrc.includes('BlueprintClassMatchToken'));
    assert.ok(cppSrc.includes("Token = Token.Mid(1)"));
    assert.ok(cppSrc.includes('BlueprintMatchesClassToken'));
  });

  it('loads blueprint assets via soft object path for findUFunctionNodes', () => {
    assert.ok(cppSrc.includes('Data.ToSoftObjectPath().TryLoad()'));
  });

  it('handshake delta avoids baseline when snapshot already populated', () => {
    assert.ok(cppSrc.includes('SinceTs <= 0 && GAssetRegistrySnapshot.Num() > 0'));
  });

  it('scans /Game and plugin content roots for asset sync', () => {
    assert.ok(cppSrc.includes('AppendProjectContentPackagePaths'));
    assert.ok(cppSrc.includes('QueryProjectAssets'));
    assert.ok(cppSrc.includes('FPaths::ProjectPluginsDir()'));
  });

  it('caps blueprint loads in findUFunctionNodes', () => {
    assert.ok(cppSrc.includes('MaxUFunctionBlueprintLoads'));
    assert.ok(cppSrc.includes('SetBoolField(TEXT("truncated")'));
    assert.ok(cppSrc.includes('BuildFindUFunctionNodesResult'));
    assert.ok(cppSrc.includes('ENamedThreads::GameThread'));
    assert.ok(cppSrc.includes('bTimedOut'));
    assert.ok(cppSrc.includes('AsyncState->Done = nullptr'));
    const timeoutBlock = cppSrc.slice(cppSrc.indexOf('if (!bCompleted)'), cppSrc.indexOf('return AsyncState->Result'));
    assert.equal(timeoutBlock.includes('ReturnSynchEventToPool'), false);
  });

  it('tails logs using byte offsets and UTF-8 decode', () => {
    assert.ok(cppSrc.includes('LoadFileToArray(FileBytes'));
    assert.ok(cppSrc.includes('FUTF8ToTCHAR'));
    assert.ok(cppSrc.includes('NewOffset = FileBytes.Num()'));
  });

  it('limits automation state updates to the active test', () => {
    assert.ok(cppSrc.includes('GActiveAutomationTestName.IsEmpty()'));
    assert.ok(cppSrc.includes('Test already running'));
  });

  it('caps referencers and dependencies graph results', () => {
    assert.ok(cppSrc.includes('MAX_BRIDGE_REFERENCERS'));
    assert.ok(cppSrc.includes('MAX_BRIDGE_DEPENDENCIES'));
    assert.ok(cppSrc.includes('QueryProjectBlueprintAssets'));
  });

  it('strips I prefix in InterfaceMatchToken for findImplementations', () => {
    assert.ok(cppSrc.includes('InterfaceMatchToken'));
    assert.ok(cppSrc.includes("Token[0] == TCHAR('I')"));
  });
});
