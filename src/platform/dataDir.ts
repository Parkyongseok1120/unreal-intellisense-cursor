import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_DATA_DIR, EXTENSION_DATA_DIR_LEGACY } from '../constants';

export function resolveDataDir(projectRoot: string): string {
  const current = path.join(projectRoot, EXTENSION_DATA_DIR);
  const legacy = path.join(projectRoot, EXTENSION_DATA_DIR_LEGACY);
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(current)) {
      return legacy;
    }
  } catch {
    // ignore
  }
  return current;
}

export async function ensureDataDir(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, EXTENSION_DATA_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}
