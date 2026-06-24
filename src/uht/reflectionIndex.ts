import * as fs from 'fs';
import * as path from 'path';
import { ensureDataDir } from '../platform/dataDir';
import { parseGeneratedHeader, parseHeaderUProperties, parseHeaderUFunctions, type UClassReflection } from './generatedHeaderParser';

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
          const classMatch = content.match(/UCLASS\s*\([^)]*\)\s*class\s+\w+\s+(\w+)/);
          const className = classMatch?.[1];
          if (!className) continue;

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

          const props = parseHeaderUProperties(content);
          const funcs = parseHeaderUFunctions(content);
          if (props.length > 0) reflection.properties = props;
          if (funcs.length > 0) reflection.functions = funcs;
        } catch {
          // skip
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await scanSource(full, depth - 1);
      }
    }
  }

  await scanSource(path.join(projectRoot, 'Source'), 12);
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
    const classMatch = content.match(/UCLASS\s*\([^)]*\)\s*class\s+\w+\s+(\w+)/);
    const className = classMatch?.[1];
    if (!className) return;

    const classes = await loadReflectionIndex(projectRoot);
    let reflection = findClassReflection(classes, className);
    if (!reflection) {
      reflection = { className, filePath: headerPath, properties: [], functions: [] };
      classes.push(reflection);
    }

    reflection.properties = parseHeaderUProperties(content);
    reflection.functions = parseHeaderUFunctions(content);
    reflection.filePath = headerPath;

    await saveReflectionIndex(projectRoot, classes);
  } catch {
    // ignore
  }
}

export type { UClassReflection } from './generatedHeaderParser';
