import * as fs from 'fs';
import * as path from 'path';
import { ensureDataDir } from '../platform/dataDir';
import { parseGeneratedHeader, parseHeaderMembersForClass, type UClassReflection } from './generatedHeaderParser';
import { parseUClassFromText } from '../blueprint/cppClassParser';
import { enrichReflectionFromHeaderContent } from '../projectModel/symbolModel';

export interface ReflectionIndexCache {
  version: number;
  updatedAt: string;
  classes: UClassReflection[];
}

const CACHE_VERSION = 1;
const CACHE_FILE = 'reflection-index.json';

async function findGeneratedHeaders(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  const intermediate = path.join(projectRoot, 'Intermediate', 'Build');

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.generated.h')) {
        results.push(full);
      } else if (entry.isDirectory()) {
        await walk(full, depth - 1);
      }
    }
  }

  await walk(intermediate, 8);
  return results;
}

async function enrichFromSourceHeaders(projectRoot: string, classes: UClassReflection[]): Promise<void> {
  const byName = new Map(classes.map((c) => [c.className.toLowerCase(), c]));

  async function scanSource(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.h') && !entry.name.endsWith('.generated.h')) {
        try {
          const content = await fs.promises.readFile(full, 'utf-8');
          const parsedClasses = parseUClassFromText(content);
          for (const parsed of parsedClasses) {
            const className = parsed.className;
            let reflection = byName.get(className.toLowerCase());
            if (!reflection) {
              reflection = {
                className,
                filePath: full,
                properties: [],
                functions: [],
              };
              classes.push(reflection);
              byName.set(className.toLowerCase(), reflection);
            }

            const { properties, functions } = parseHeaderMembersForClass(content, className);
            if (properties.length > 0) reflection.properties = properties;
            if (functions.length > 0) reflection.functions = functions;
            reflection.filePath = full;
            enrichReflectionFromHeaderContent(reflection, content, full);
          }
        } catch {
          // skip
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await scanSource(full, depth - 1);
      }
    }
  }

  await scanSource(path.join(projectRoot, 'Source'), 12);
  const pluginsDir = path.join(projectRoot, 'Plugins');
  if (fs.existsSync(pluginsDir)) {
    await scanSource(pluginsDir, 16);
  }
}

export async function buildReflectionIndex(projectRoot: string): Promise<UClassReflection[]> {
  const generatedFiles = await findGeneratedHeaders(projectRoot);
  const classes: UClassReflection[] = [];

  for (const filePath of generatedFiles) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      classes.push(...parseGeneratedHeader(content, filePath));
    } catch {
      // skip
    }
  }

  await enrichFromSourceHeaders(projectRoot, classes);

  const deduped = new Map<string, UClassReflection>();
  for (const c of classes) {
    deduped.set(c.className.toLowerCase(), c);
  }
  return [...deduped.values()].sort((a, b) => a.className.localeCompare(b.className));
}

export async function saveReflectionIndex(projectRoot: string, classes: UClassReflection[]): Promise<string> {
  const dir = await ensureDataDir(projectRoot);
  const cache: ReflectionIndexCache = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    classes,
  };
  const filePath = path.join(dir, CACHE_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  return filePath;
}

export async function loadReflectionIndex(projectRoot: string): Promise<UClassReflection[]> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, CACHE_FILE), 'utf-8');
      const cache = JSON.parse(raw) as ReflectionIndexCache;
      return cache.classes ?? [];
    } catch {
      // try next
    }
  }
  return [];
}

export async function refreshReflectionIndex(projectRoot: string): Promise<UClassReflection[]> {
  const classes = await buildReflectionIndex(projectRoot);
  await saveReflectionIndex(projectRoot, classes);
  return classes;
}

export async function getOrBuildReflectionIndex(projectRoot: string): Promise<UClassReflection[]> {
  const cached = await loadReflectionIndex(projectRoot);
  if (cached.length > 0) return cached;
  return refreshReflectionIndex(projectRoot);
}

export function findClassReflection(classes: UClassReflection[], className: string): UClassReflection | undefined {
  return classes.find((c) => c.className.toLowerCase() === className.toLowerCase());
}

export async function refreshReflectionForHeader(projectRoot: string, headerPath: string): Promise<void> {
  try {
    const content = await fs.promises.readFile(headerPath, 'utf-8');
    const parsedClasses = parseUClassFromText(content);
    if (parsedClasses.length === 0) return;

    const classes = await loadReflectionIndex(projectRoot);
    const touched = new Set<string>();

    for (const parsed of parsedClasses) {
      const className = parsed.className;
      touched.add(className.toLowerCase());
      let reflection = findClassReflection(classes, className);
      if (!reflection) {
        reflection = { className, filePath: headerPath, properties: [], functions: [] };
        classes.push(reflection);
      }

      const { properties, functions } = parseHeaderMembersForClass(content, className);
      reflection.properties = properties;
      reflection.functions = functions;
      reflection.filePath = headerPath;
      enrichReflectionFromHeaderContent(reflection, content, headerPath);
    }

    await saveReflectionIndex(projectRoot, classes);

    const { patchSemanticGraphForHeader } = await import('../projectModel/projectModelService');
    await patchSemanticGraphForHeader(projectRoot, headerPath, classes.filter((c) => touched.has(c.className.toLowerCase())));
  } catch {
    // ignore
  }
}

export type { UClassReflection } from './generatedHeaderParser';
