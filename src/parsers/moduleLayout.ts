import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';

export interface ModuleLayout {
  moduleName: string;
  moduleRoot: string;
  publicDir?: string;
  privateDir?: string;
}

const SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx']);
const HEADER_EXTS = new Set(['.h', '.hpp', '.inl']);

function normalize(p: string): string {
  return path.normalize(p).replace(/\\/g, '/');
}

async function scanSourceRoot(sourceRoot: string, layouts: ModuleLayout[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleRoot = path.join(sourceRoot, entry.name);
    const publicDir = path.join(moduleRoot, 'Public');
    const privateDir = path.join(moduleRoot, 'Private');
    const hasPublic = await fileExists(publicDir);
    const hasPrivate = await fileExists(privateDir);
    if (!hasPublic && !hasPrivate) continue;

    layouts.push({
      moduleName: entry.name,
      moduleRoot: normalize(moduleRoot),
      publicDir: hasPublic ? normalize(publicDir) : undefined,
      privateDir: hasPrivate ? normalize(privateDir) : undefined,
    });
  }
}

// UE module layout scan: Source/Module/Public, Source/Module/Private, and Plugins/*/Source/*.
export async function discoverModuleLayouts(projectRoot: string): Promise<ModuleLayout[]> {
  const layouts: ModuleLayout[] = [];
  await scanSourceRoot(path.join(projectRoot, 'Source'), layouts);

  const pluginsDir = path.join(projectRoot, 'Plugins');
  try {
    const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      await scanSourceRoot(path.join(pluginsDir, plugin.name, 'Source'), layouts);
    }
  } catch {
    // no Plugins/
  }

  return layouts;
}

export function moduleIncludePaths(layouts: ModuleLayout[]): string[] {
  const includes = new Set<string>();
  for (const layout of layouts) {
    if (layout.publicDir) includes.add(layout.publicDir);
    if (layout.privateDir) includes.add(layout.privateDir);
  }
  return [...includes];
}

export interface PublicPrivateContext {
  moduleRoot: string;
  publicRoot: string;
  privateRoot: string;
  relativeDir: string;
  side: 'public' | 'private';
}

/** 파일 경로에서 UE 모듈 Public/Private 루트와 상대 하위 경로 추출 */
export function resolvePublicPrivateContext(filePath: string): PublicPrivateContext | undefined {
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

function pairedPath(
  ctx: PublicPrivateContext,
  targetSide: 'public' | 'private',
  baseName: string,
  extensions: string[],
): string | undefined {
  const root = targetSide === 'public' ? ctx.publicRoot : ctx.privateRoot;
  for (const ext of extensions) {
    const candidate = ctx.relativeDir
      ? path.join(root, ctx.relativeDir, `${baseName}${ext}`)
      : path.join(root, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return undefined;
}

/** Public/Private 분리 UE 모듈에서 대응 .h ↔ .cpp 경로 탐색 */
export function findPairedSourceFile(currentPath: string): string | undefined {
  const ext = path.extname(currentPath).toLowerCase();
  const baseName = path.basename(currentPath, ext);
  const ctx = resolvePublicPrivateContext(currentPath);

  if (ctx) {
    if (HEADER_EXTS.has(ext)) {
      return pairedPath(ctx, 'private', baseName, ['.cpp', '.cc', '.cxx']);
    }
    if (SOURCE_EXTS.has(ext)) {
      return pairedPath(ctx, 'public', baseName, ['.h', '.hpp', '.inl']);
    }
  }

  const dir = path.dirname(currentPath);
  const name = baseName;

  if (HEADER_EXTS.has(ext)) {
    const candidates = [
      path.join(dir, 'Private', `${name}.cpp`),
      path.join(dir, '..', 'Private', `${name}.cpp`),
      path.join(dir, `${name}.cpp`),
      path.join(path.dirname(dir), 'Private', `${name}.cpp`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return path.normalize(candidate);
    }
  }

  if (SOURCE_EXTS.has(ext)) {
    const candidates = [
      path.join(dir, 'Public', `${name}.h`),
      path.join(dir, '..', 'Public', `${name}.h`),
      path.join(dir, `${name}.h`),
      path.join(path.dirname(dir), 'Public', `${name}.h`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return path.normalize(candidate);
    }
  }

  return undefined;
}
