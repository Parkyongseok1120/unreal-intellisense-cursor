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
});
