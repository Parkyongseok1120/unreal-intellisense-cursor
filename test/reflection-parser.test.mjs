import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'sample.generated.h');

function parseGeneratedHeader(content, filePath) {
  const classes = [];
  const classNameMatch = content.match(/class\s+(\w+)\s*:\s*public\s+(\w+)/);
  const className = classNameMatch?.[1];
  if (!className) return classes;

  const reflection = {
    className,
    superClass: classNameMatch?.[2],
    filePath,
    properties: [],
    functions: [],
  };

  const nameRe = /static\s+const\s+UECodeGen_Private::FMetaDataPairParam\s+(\w+)_MetaData\[\]/g;
  let m;
  while ((m = nameRe.exec(content)) !== null) {
    reflection.properties.push({ name: m[1].replace(/_MetaData$/, ''), type: 'UProperty' });
  }

  const execRe = /(\w+)_Implementation\s*\(/g;
  let em;
  while ((em = execRe.exec(content)) !== null) {
    const fn = em[1];
    if (!reflection.functions.some((f) => f.name === fn)) {
      reflection.functions.push({ name: fn, flags: 'BlueprintNativeEvent' });
    }
  }

  classes.push(reflection);
  return classes;
}

describe('generated.h parser', () => {
  it('parses sample fixture class and properties', () => {
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const classes = parseGeneratedHeader(content, fixturePath);
    assert.equal(classes.length, 1);
    assert.equal(classes[0].className, 'AMyGameMode');
    assert.equal(classes[0].superClass, 'AGameModeBase');
    assert.ok(classes[0].properties.some((p) => p.name === 'Health'));
  });

  it('parses BlueprintNativeEvent implementations', () => {
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const classes = parseGeneratedHeader(content, fixturePath);
    assert.ok(classes[0].functions.some((f) => f.name === 'BeginPlay'));
  });
});
