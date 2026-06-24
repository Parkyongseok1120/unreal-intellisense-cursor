import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function resolvePublicPrivateContext(filePath) {
  const normalized = path.normalize(filePath);
  const segments = normalized.split(path.sep);
  for (let i = segments.length - 1; i >= 1; i--) {
    const segment = segments[i];
    if (segment !== 'Public' && segment !== 'Private') continue;
    if (segments[i - 1] === 'Intermediate') continue;
    const moduleRoot = segments.slice(0, i).join(path.sep);
    const relativeDir = segments.slice(i + 1, segments.length - 1).join(path.sep);
    return {
      moduleRoot,
      publicRoot: path.join(moduleRoot, 'Public'),
      privateRoot: path.join(moduleRoot, 'Private'),
      relativeDir,
      side: segment === 'Public' ? 'public' : 'private',
    };
  }
  return undefined;
}

function pairedPath(ctx, targetSide, baseName, extensions) {
  const rootDir = targetSide === 'public' ? ctx.publicRoot : ctx.privateRoot;
  for (const ext of extensions) {
    const candidate = ctx.relativeDir
      ? path.join(rootDir, ctx.relativeDir, `${baseName}${ext}`)
      : path.join(rootDir, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return undefined;
}

function findPairedSourceFile(currentPath) {
  const ext = path.extname(currentPath).toLowerCase();
  const baseName = path.basename(currentPath, ext);
  const ctx = resolvePublicPrivateContext(currentPath);
  if (!ctx) return undefined;
  if (['.h', '.hpp', '.inl'].includes(ext)) {
    return pairedPath(ctx, 'private', baseName, ['.cpp', '.cc', '.cxx']);
  }
  if (['.cpp', '.cc', '.cxx'].includes(ext)) {
    return pairedPath(ctx, 'public', baseName, ['.h', '.hpp', '.inl']);
  }
  return undefined;
}

describe('resolvePublicPrivateContext', () => {
  it('parses Private cpp subpath', () => {
    const p = 'C:/Proj/Source/Project_MJS/Private/Character/Enemy/EnemyCharacter.cpp';
    const ctx = resolvePublicPrivateContext(p);
    assert.equal(ctx?.side, 'private');
    assert.equal(ctx?.relativeDir.replace(/\\/g, '/'), 'Character/Enemy');
    assert.match(ctx?.publicRoot ?? '', /Source[\\/]Project_MJS[\\/]Public$/);
  });

  it('parses Public header subpath', () => {
    const p = 'C:/Proj/Source/Project_MJS/Public/Character/Enemy/EnemyCharacter.h';
    const ctx = resolvePublicPrivateContext(p);
    assert.equal(ctx?.side, 'public');
    assert.equal(ctx?.relativeDir.replace(/\\/g, '/'), 'Character/Enemy');
  });
});

describe('findPairedSourceFile (Project_MJS layout)', () => {
  const projectRoot = path.join(root, '..', '..', 'Project_MJS');
  const header = path.join(
    projectRoot,
    'Source',
    'Project_MJS',
    'Public',
    'Character',
    'Enemy',
    'EnemyCharacter.h',
  );
  const source = path.join(
    projectRoot,
    'Source',
    'Project_MJS',
    'Private',
    'Character',
    'Enemy',
    'EnemyCharacter.cpp',
  );

  it('links Private cpp to Public header', () => {
    if (!fs.existsSync(source)) return;
    assert.equal(findPairedSourceFile(source), path.normalize(header));
  });

  it('links Public header to Private cpp', () => {
    if (!fs.existsSync(header)) return;
    assert.equal(findPairedSourceFile(header), path.normalize(source));
  });
});
