import * as fs from 'fs';
import * as path from 'path';

export interface ModuleLayout {
  moduleName: string;
  moduleRoot: string;
  publicDir?: string;
  privateDir?: string;
  classesDir?: string;
}

const SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx']);
const HEADER_EXTS = new Set(['.h', '.hpp', '.inl']);
const CPP_SOURCE_EXTS = ['.cpp', '.cc', '.cxx'];
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const HEADER_FILE_EXTS = ['.h', '.hpp', '.inl'];

function normalize(p: string): string {
  return path.normalize(p).replace(/\\/g, '/');
}

/** Strip .generated from Foo.generated.h basenames before pairing */
export function normalizePairingBaseName(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  let base = path.basename(filePath, ext);
  if (base.endsWith('.generated')) {
    base = base.slice(0, -'.generated'.length);
  }
  return base;
}

async function registerModuleLayout(
  moduleRoot: string,
  moduleName: string,
  layouts: ModuleLayout[],
): Promise<void> {
  const publicDir = path.join(moduleRoot, 'Public');
  const privateDir = path.join(moduleRoot, 'Private');
  const classesDir = path.join(moduleRoot, 'Classes');
  const hasPublic = await fileExists(publicDir);
  const hasPrivate = await fileExists(privateDir);
  const hasClasses = await fileExists(classesDir);

  if (!hasPublic && !hasPrivate && !hasClasses) {
    layouts.push({
      moduleName,
      moduleRoot: normalize(moduleRoot),
    });
    return;
  }

  layouts.push({
    moduleName,
    moduleRoot: normalize(moduleRoot),
    publicDir: hasPublic ? normalize(publicDir) : hasClasses ? normalize(classesDir) : undefined,
    privateDir: hasPrivate ? normalize(privateDir) : undefined,
    classesDir: hasClasses ? normalize(classesDir) : undefined,
  });
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
    await registerModuleLayout(path.join(sourceRoot, entry.name), entry.name, layouts);
  }
}

async function walkPluginsForSource(pluginsDir: string, layouts: ModuleLayout[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(pluginsDir, entry.name);
    const sourceDir = path.join(full, 'Source');
    if (await fileExists(sourceDir)) {
      await scanSourceRoot(sourceDir, layouts);
    }
    await walkPluginsForSource(full, layouts);
  }
}

// UE module layout scan: Source/Module, Plugins/**/Source/* (recursive).
export async function discoverModuleLayouts(projectRoot: string): Promise<ModuleLayout[]> {
  const layouts: ModuleLayout[] = [];
  await scanSourceRoot(path.join(projectRoot, 'Source'), layouts);

  const pluginsDir = path.join(projectRoot, 'Plugins');
  await walkPluginsForSource(pluginsDir, layouts);

  return layouts;
}

export function moduleIncludePaths(layouts: ModuleLayout[]): string[] {
  const includes = new Set<string>();
  for (const layout of layouts) {
    if (layout.publicDir) includes.add(layout.publicDir);
    if (layout.privateDir) includes.add(layout.privateDir);
    if (layout.classesDir) includes.add(layout.classesDir);
    if (!layout.publicDir && !layout.privateDir && !layout.classesDir) {
      includes.add(layout.moduleRoot);
    }
  }
  return [...includes];
}

export interface PublicPrivateContext {
  moduleRoot: string;
  publicRoot: string;
  privateRoot: string;
  relativeDir: string;
  side: 'public' | 'private' | 'classes' | 'flat';
}

/** 파일 경로에서 UE 모듈 Public/Private/Classes 루트와 상대 하위 경로 추출 */
export function resolvePublicPrivateContext(filePath: string): PublicPrivateContext | undefined {
  const normalized = path.normalize(filePath);
  const segments = normalized.split(path.sep);

  for (let i = segments.length - 1; i >= 1; i--) {
    const segment = segments[i];
    if (segment !== 'Public' && segment !== 'Private' && segment !== 'Classes') continue;
    if (segments[i - 1] === 'Intermediate') continue;

    const moduleRoot = segments.slice(0, i).join(path.sep);
    const relativeDir = segments.slice(i + 1, segments.length - 1).join(path.sep);
    const publicRoot = fs.existsSync(path.join(moduleRoot, 'Public'))
      ? path.join(moduleRoot, 'Public')
      : path.join(moduleRoot, 'Classes');
    return {
      moduleRoot,
      publicRoot,
      privateRoot: path.join(moduleRoot, 'Private'),
      relativeDir,
      side: segment === 'Public' ? 'public' : segment === 'Private' ? 'private' : 'classes',
    };
  }

  const sourceIdx = segments.findIndex((s) => s === 'Source');
  if (sourceIdx >= 0 && sourceIdx + 1 < segments.length - 1) {
    const moduleRoot = segments.slice(0, sourceIdx + 2).join(path.sep);
    const relativeDir = segments.slice(sourceIdx + 2, segments.length - 1).join(path.sep);
    return {
      moduleRoot,
      publicRoot: moduleRoot,
      privateRoot: moduleRoot,
      relativeDir,
      side: 'flat',
    };
  }

  return undefined;
}

function firstExisting(paths: string[]): string | undefined {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return undefined;
}

function pairedPath(
  ctx: PublicPrivateContext,
  targetSide: 'public' | 'private',
  baseName: string,
  extensions: string[],
  relativeDir?: string,
): string | undefined {
  const rel = relativeDir ?? ctx.relativeDir;
  const root =
    targetSide === 'public'
      ? ctx.publicRoot
      : targetSide === 'private'
        ? ctx.privateRoot
        : ctx.moduleRoot;
  for (const ext of extensions) {
    const candidate = rel ? path.join(root, rel, `${baseName}${ext}`) : path.join(root, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return undefined;
}

function findViaIncludeHint(currentPath: string, baseName: string, isHeaderFile: boolean): string | undefined {
  if (isHeaderFile || !SOURCE_EXTS.has(path.extname(currentPath).toLowerCase())) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(currentPath, 'utf-8');
  } catch {
    return undefined;
  }
  const includeRe = /#include\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = includeRe.exec(content))) {
    const includePath = match[1];
    const includeBase = path.basename(includePath, path.extname(includePath));
    if (includeBase !== baseName && !includePath.endsWith(`${baseName}.h`)) continue;
    const dir = path.dirname(currentPath);
    const candidates = [
      path.join(dir, includePath),
      path.join(dir, '..', 'Public', includePath),
      path.join(dir, '..', 'Classes', includePath),
      path.join(dir, '..', includePath),
    ];
    const found = firstExisting(candidates);
    if (found) return found;
  }
  return undefined;
}

function findPairedWithContext(
  ctx: PublicPrivateContext,
  baseName: string,
  isHeaderFile: boolean,
): string | undefined {
  if (isHeaderFile) {
    const primary = pairedPath(ctx, 'private', baseName, CPP_SOURCE_EXTS);
    if (primary) return primary;
    const basenameOnly = pairedPath(ctx, 'private', baseName, CPP_SOURCE_EXTS, '');
    if (basenameOnly) return basenameOnly;
    const sameSide = pairedPath(ctx, ctx.side === 'private' ? 'private' : 'public', baseName, CPP_SOURCE_EXTS);
    if (sameSide && sameSide !== path.normalize(path.join(ctx.moduleRoot, ''))) return sameSide;
    if (ctx.side === 'flat') {
      return firstExisting([path.join(ctx.moduleRoot, `${baseName}.cpp`), path.join(ctx.moduleRoot, `${baseName}.cc`)]);
    }
    return undefined;
  }

  const primary = pairedPath(ctx, 'public', baseName, HEADER_FILE_EXTS);
  if (primary) return primary;
  const basenameOnly = pairedPath(ctx, 'public', baseName, HEADER_FILE_EXTS, '');
  if (basenameOnly) return basenameOnly;
  const sameSide = pairedPath(ctx, ctx.side === 'public' || ctx.side === 'classes' ? 'public' : 'private', baseName, HEADER_FILE_EXTS);
  if (sameSide) return sameSide;
  if (ctx.side === 'flat') {
    return firstExisting([path.join(ctx.moduleRoot, `${baseName}.h`), path.join(ctx.moduleRoot, `${baseName}.hpp`)]);
  }
  return undefined;
}

/** Public/Private 분리 UE 모듈에서 대응 .h ↔ .cpp 경로 탐색 */
export function findPairedSourceFile(currentPath: string): string | undefined {
  const ext = path.extname(currentPath).toLowerCase();
  const baseName = normalizePairingBaseName(currentPath);
  const isGeneratedHeader = /\.generated\.h$/i.test(currentPath);
  const isHeaderFile = HEADER_EXTS.has(ext) && !isGeneratedHeader;
  const isSourceFile = SOURCE_EXTS.has(ext);
  if (!isHeaderFile && !isSourceFile && !isGeneratedHeader) return undefined;

  if (isGeneratedHeader) {
    const genCtx = resolvePublicPrivateContext(currentPath);
    if (genCtx) {
      const header = pairedPath(genCtx, 'public', baseName, HEADER_FILE_EXTS);
      if (header) return header;
    }
    const dir = path.dirname(currentPath);
    const candidates = [];
    for (const hExt of HEADER_FILE_EXTS) {
      candidates.push(
        path.join(dir, '..', 'Public', baseName + hExt),
        path.join(dir, '..', 'Classes', baseName + hExt),
        path.join(dir, 'Public', baseName + hExt),
        path.join(dir, baseName + hExt),
      );
    }
    const found = firstExisting(candidates);
    if (found) return found;
    return undefined;
  }

  const ctx = resolvePublicPrivateContext(currentPath);
  if (ctx) {
    const paired = findPairedWithContext(ctx, baseName, isHeaderFile);
    if (paired) return paired;
  }

  const dir = path.dirname(currentPath);

  if (isHeaderFile) {
    const candidates: string[] = [];
    for (const cppExt of CPP_SOURCE_EXTS) {
      candidates.push(
        path.join(dir, 'Private', `${baseName}${cppExt}`),
        path.join(dir, '..', 'Private', `${baseName}${cppExt}`),
        path.join(dir, `${baseName}${cppExt}`),
        path.join(path.dirname(dir), 'Private', `${baseName}${cppExt}`),
        path.join(dir, '..', `${baseName}${cppExt}`),
      );
    }
    const found = firstExisting(candidates);
    if (found) return found;
  }

  if (isSourceFile) {
    const candidates: string[] = [];
    for (const hExt of HEADER_FILE_EXTS) {
      candidates.push(
        path.join(dir, 'Public', `${baseName}${hExt}`),
        path.join(dir, '..', 'Public', `${baseName}${hExt}`),
        path.join(dir, 'Classes', `${baseName}${hExt}`),
        path.join(dir, `${baseName}${hExt}`),
        path.join(path.dirname(dir), 'Public', `${baseName}${hExt}`),
        path.join(dir, '..', `${baseName}${hExt}`),
      );
    }
    const found = firstExisting(candidates);
    if (found) return found;
    return findViaIncludeHint(currentPath, baseName, isHeaderFile);
  }

  return undefined;
}

/** Synchronous module root lookup for wizard / commands */
export function findModuleRootSync(projectRoot: string, moduleName: string): string | undefined {
  const direct = path.join(projectRoot, 'Source', moduleName);
  if (fs.existsSync(direct)) return path.normalize(direct);

  const pluginsDir = path.join(projectRoot, 'Plugins');
  if (!fs.existsSync(pluginsDir)) return undefined;

  const walk = (dir: string): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const sourceModule = path.join(full, 'Source', moduleName);
      if (fs.existsSync(sourceModule)) return path.normalize(sourceModule);
      const nested = walk(full);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(pluginsDir);
}
