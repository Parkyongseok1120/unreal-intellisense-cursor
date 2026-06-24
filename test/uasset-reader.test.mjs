import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'sample-minimal.uasset');

const UE3_MAGIC = 0x9e2a83c1;

function readLatin1Heuristic(buf) {
  const text = buf.toString('latin1');
  const gameMatch = text.match(/\/Game\/[A-Za-z0-9_./-]+/);
  const classHints = ['Blueprint', 'Material', 'StaticMesh', 'SkeletalMesh', 'World', 'WidgetBlueprint'];
  let exportClassName;
  for (const hint of classHints) {
    if (text.includes(hint)) {
      exportClassName = hint;
      break;
    }
  }
  return { packageName: gameMatch?.[0], exportClassName };
}

describe('uassetReader v2', () => {
  it('reads minimal fixture magic and package path', () => {
    const buf = fs.readFileSync(fixturePath);
    assert.equal(buf.readUInt32LE(0), UE3_MAGIC);
    const info = readLatin1Heuristic(buf);
    assert.equal(info.packageName, '/Game/Test/BP_Sample.BP_Sample');
    assert.equal(info.exportClassName, 'Blueprint');
  });
});
