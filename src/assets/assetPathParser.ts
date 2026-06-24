export interface AssetPathMatch {
  assetPath: string;
  start: number;
  end: number;
  line: number;
}

const GAME_PATH_RE = /\/Game\/[A-Za-z0-9_./-]+/g;

const PATTERNS: RegExp[] = [
  /TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /FSoftObjectPath\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /TSoftObjectPtr\s*<\s*[^>]+>\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /TSubclassOf\s*<\s*[^>]+>\s*\(\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)\s*\)/g,
  /TSubclassOf\s*<\s*[^>]+>\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /FPrimaryAssetId(?:\s+\w+)?\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g,
  /ConstructorHelpers::FObjectFinder\s*<\s*[^>]+>\s*\(\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)\s*\)/g,
  /ConstructorHelpers::FClassFinder\s*<\s*[^>]+>\s*\(\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)\s*\)/g,
  /LoadObject\s*<\s*[^>]+>\s*\([^,]+,\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /StaticLoadObject\s*\([^,]+,\s*[^,]+,\s*TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
  /FAssetData\s*\(\s*"(\/Game\/[^"]+)"\s*\)/g,
];

export function findAssetPathsInLine(line: string, lineNumber: number): AssetPathMatch[] {
  const results: AssetPathMatch[] = [];
  const seen = new Set<string>();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
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
  let raw: RegExpExecArray | null;
  while ((raw = GAME_PATH_RE.exec(line)) !== null) {
    const assetPath = raw[0];
    const key = `${lineNumber}:${assetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ assetPath, start: raw.index, end: raw.index + assetPath.length, line: lineNumber });
  }

  return results;
}

export function findAssetPathsInDocument(text: string): AssetPathMatch[] {
  const lines = text.split('\n');
  const all: AssetPathMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    all.push(...findAssetPathsInLine(lines[i], i));
  }
  return all;
}

export function normalizeAssetPath(assetPath: string): string {
  let p = assetPath.replace(/\\/g, '/').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}
