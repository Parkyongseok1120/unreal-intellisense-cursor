import { readFileSync } from 'fs';
import { join } from 'path';

let cachedVersion: string | undefined;

export function getExtensionVersion(extensionRoot?: string): string {
  if (cachedVersion) return cachedVersion;
  const candidates = [
    extensionRoot ? join(extensionRoot, 'package.json') : undefined,
    join(__dirname, '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ].filter((p): p is string => !!p);

  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {
      // try next
    }
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}
