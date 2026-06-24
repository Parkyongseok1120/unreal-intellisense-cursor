import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const GAME_PATH_RE = /\/Game\/[A-Za-z0-9_./-]+/g;

const PATTERNS = [
  /TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /FSoftObjectPath\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /TSubclassOf\s*<\s*[^>]+>\s*\(\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)\s*\)/g,
  /FPrimaryAssetId(?:\s+\w+)?\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g,
  /ConstructorHelpers::FClassFinder\s*<\s*[^>]+>\s*\(\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)\s*\)/g,
  /FAssetData\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
];

function findAssetPathsInLine(line, lineNumber) {
  const results = [];
  const seen = new Set();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      let assetPath = m[1] ?? m[0];
      if (re.source.includes('FPrimaryAssetId') && m[2]) {
        assetPath = `/Game/${m[2]}`;
      }
      if (!assetPath.includes('/Game/')) continue;
      const key = `${lineNumber}:${assetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pathInMatch = m[0].includes(assetPath) ? assetPath : (m[2] ?? assetPath);
      const start = m.index + m[0].indexOf(pathInMatch);
      results.push({ assetPath, start, end: start + assetPath.length, line: lineNumber });
    }
  }

  GAME_PATH_RE.lastIndex = 0;
  let raw;
  while ((raw = GAME_PATH_RE.exec(line)) !== null) {
    const assetPath = raw[0];
    const key = `${lineNumber}:${assetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ assetPath, start: raw.index, end: raw.index + assetPath.length, line: lineNumber });
  }

  return results;
}

describe('assetPathParser', () => {
  it('finds TEXT macro paths', () => {
    const line = 'static ConstructorHelpers::FObjectFinder<UMesh> Mesh(TEXT("/Game/Meshes/SM_Box.SM_Box"));';
    const hits = findAssetPathsInLine(line, 0);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].assetPath, '/Game/Meshes/SM_Box.SM_Box');
  });

  it('finds FSoftObjectPath', () => {
    const line = 'FSoftObjectPath Path("/Game/UI/WBP_HUD.WBP_HUD");';
    const hits = findAssetPathsInLine(line, 5);
    assert.equal(hits[0].assetPath, '/Game/UI/WBP_HUD.WBP_HUD');
    assert.equal(hits[0].line, 5);
  });

  it('finds TSubclassOf TEXT macro', () => {
    const line = 'TSubclassOf<AActor> Cls(TSubclassOf<AActor>(TEXT("/Game/BP_MyActor.BP_MyActor")));';
    const hits = findAssetPathsInLine(line, 0);
    assert.ok(hits.some((h) => h.assetPath === '/Game/BP_MyActor.BP_MyActor'));
  });

  it('finds FPrimaryAssetId path', () => {
    const line = 'FPrimaryAssetId Id("Item", "Weapons/Sword");';
    const hits = findAssetPathsInLine(line, 0);
    assert.ok(hits.some((h) => h.assetPath === '/Game/Weapons/Sword'));
  });

  it('finds ConstructorHelpers::FClassFinder', () => {
    const line = 'static ConstructorHelpers::FClassFinder<APawn> PawnClass(TEXT("/Game/BP_Pawn.BP_Pawn"));';
    const hits = findAssetPathsInLine(line, 0);
    assert.equal(hits[0].assetPath, '/Game/BP_Pawn.BP_Pawn');
  });

  it('finds FAssetData string literal', () => {
    const line = 'FAssetData Data("/Game/Maps/MainLevel.MainLevel");';
    const hits = findAssetPathsInLine(line, 0);
    assert.equal(hits[0].assetPath, '/Game/Maps/MainLevel.MainLevel');
  });
});

function parseHeaderUProperties(content) {
  const props = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('UPROPERTY')) continue;
    let meta = '';
    const metaMatch = line.match(/UPROPERTY\s*\(([^)]*)\)/);
    meta = metaMatch?.[1] ?? '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const decl = lines[j].trim();
      const m = decl.match(/^([\w:<>,\s*&]+)\s+(\w+)\s*;/);
      if (m) {
        props.push({ name: m[2], type: m[1].trim(), meta, line: j + 1 });
        break;
      }
    }
  }
  return props;
}

describe('UHT header parser', () => {
  it('parses UPROPERTY declarations', () => {
    const header = `
UCLASS()
class AMyActor : public AActor
{
  UPROPERTY(EditAnywhere, BlueprintReadWrite)
  float Health;
};
`;
    const props = parseHeaderUProperties(header);
    assert.equal(props.length, 1);
    assert.equal(props[0].name, 'Health');
    assert.ok(props[0].type.includes('float'));
    assert.ok(props[0].meta.includes('EditAnywhere'));
  });
});
