import { spawnAsync } from './process';

export async function readRegistryValue(keyPath: string, valueName: string): Promise<string | undefined> {
  try {
    const result = await spawnAsync('reg', ['query', keyPath, '/v', valueName], { shell: true });
    if (result.exitCode !== 0) return undefined;
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes(valueName)) {
        const match = trimmed.match(/REG_\w+\s+(.+)/);
        if (match) return match[1].trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function enumerateRegistrySubKeys(keyPath: string): Promise<string[]> {
  try {
    const result = await spawnAsync('reg', ['query', keyPath], { shell: true });
    if (result.exitCode !== 0) return [];
    const subKeys: string[] = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(keyPath + '\\')) {
        const subKey = trimmed.slice(keyPath.length + 1);
        if (subKey && !subKey.includes('\\')) subKeys.push(subKey);
      }
    }
    return subKeys;
  } catch {
    return [];
  }
}

export async function readRegistryKeyValues(keyPath: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  try {
    const result = await spawnAsync('reg', ['query', keyPath], { shell: true });
    if (result.exitCode !== 0) return values;
    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^(\S+)\s+REG_\w+\s+(.+)/);
      if (match) values.set(match[1], match[2].trim());
    }
  } catch {
    // ignore
  }
  return values;
}
