import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'test', 'fixtures', 'synthetic-ue-project');

const SKIP_DIRS = new Set(['Intermediate', 'Saved', '.ue5_8cursor', '.ue58rider', '.cursor', 'Binaries', 'DerivedDataCache']);

export function syntheticFixtureSource(): string {
  return fixtureRoot;
}

export async function copySyntheticProject(destRoot: string): Promise<string> {
  await fs.promises.mkdir(destRoot, { recursive: true });
  await copyTree(fixtureRoot, destRoot, fixtureRoot);
  return destRoot;
}

async function copyTree(src: string, dest: string, root: string): Promise<void> {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true });
      await copyTree(from, to, root);
    } else {
      await fs.promises.copyFile(from, to);
    }
  }
}

export async function cleanupSyntheticProject(destRoot: string): Promise<void> {
  await fs.promises.rm(destRoot, { recursive: true, force: true });
}
