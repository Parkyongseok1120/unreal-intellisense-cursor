import * as fs from 'fs';
import * as path from 'path';
import { resolveEditorPath as platformEditorPath, resolveUbtPath } from './platform';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveUBTPath(engineRoot: string): string {
  return resolveUbtPath(engineRoot);
}

export function resolveEditorPath(engineRoot: string): string {
  return platformEditorPath(engineRoot);
}
