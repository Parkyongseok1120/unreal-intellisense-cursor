import * as fs from 'fs';
import * as path from 'path';
import { ensureDataDir } from '../platform/dataDir';
import { discoverModuleLayouts, moduleIncludePaths } from '../parsers/moduleLayout';

const STUBS_FILE = 'UHTIDEStubs.h';

export async function ensureUhtStubs(projectRoot: string, extensionTemplatesPath: string): Promise<string> {
  const dir = await ensureDataDir(projectRoot);

  const dest = path.join(dir, STUBS_FILE);
  const src = path.join(extensionTemplatesPath, 'templates', STUBS_FILE);

  try {
    const content = await fs.promises.readFile(src, 'utf-8');
    let existing = '';
    try {
      existing = await fs.promises.readFile(dest, 'utf-8');
    } catch {
      // new
    }
    if (existing !== content) {
      await fs.promises.writeFile(dest, content, 'utf-8');
    }
  } catch {
    // fallback inline minimal stubs if template not found
    const minimal = '#pragma once\n#define GENERATED_BODY(...)\n#define UPROPERTY(...)\n#define UFUNCTION(...)\n';
    await fs.promises.writeFile(dest, minimal, 'utf-8');
  }

  return dest.replace(/\\/g, '/');
}

async function scanIntermediateIncDirs(projectRoot: string): Promise<string[]> {
  const results = new Set<string>();
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
      if (entry.isDirectory()) {
        if (entry.name === 'Inc') {
          results.add(full.replace(/\\/g, '/'));
        } else {
          await walk(full, depth - 1);
        }
      }
    }
  }

  await walk(intermediate, 6);
  return [...results];
}

export async function discoverIntermediateIncludePaths(projectRoot: string): Promise<string[]> {
  const compileDb = path.join(projectRoot, 'compile_commands.json');
  const includes = new Set<string>();

  try {
    const raw = await fs.promises.readFile(compileDb, 'utf-8');
    const entries = JSON.parse(raw) as Array<{ command?: string; arguments?: string[] }>;
    for (const entry of entries) {
      const args = entry.arguments ?? entry.command?.split(/\s+/) ?? [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '-I' || arg === '/I') && args[i + 1]) {
          const inc = args[i + 1].replace(/\\/g, '/');
          if (inc.includes('Intermediate') || inc.includes('Generated')) {
            includes.add(inc);
          }
          i++;
        } else if (arg.startsWith('-I') && arg.length > 2) {
          const inc = arg.slice(2).replace(/\\/g, '/');
          if (inc.includes('Intermediate') || inc.includes('Generated')) includes.add(inc);
        }
      }
    }
  } catch {
    // no compile db yet
  }

  const intermediate = path.join(projectRoot, 'Intermediate', 'Build', 'Win64');
  try {
    const targets = await fs.promises.readdir(intermediate, { withFileTypes: true });
    for (const t of targets) {
      if (t.isDirectory() && t.name.includes('Editor')) {
        includes.add(path.join(intermediate, t.name, 'Inc').replace(/\\/g, '/'));
      }
    }
  } catch {
    // ignore
  }

  for (const inc of await scanIntermediateIncDirs(projectRoot)) {
    includes.add(inc);
  }

  return [...includes];
}

export async function discoverModuleIncludePaths(projectRoot: string): Promise<string[]> {
  const layouts = await discoverModuleLayouts(projectRoot);
  return moduleIncludePaths(layouts);
}

export function stubsIncludeFlag(stubsPath: string): string[] {
  return ['-include', stubsPath];
}
