import * as path from 'path';

/**
 * Parse a Windows command line using CommandLineToArgvW-compatible quote and
 * backslash handling. UBT may emit command-form compile database entries, so
 * splitting on whitespace or a quote-only regexp corrupts paths such as
 * `C:\\UE Projects\\한글\\Foo.cpp` and escaped definition values.
 */
export function parseWindowsCommandLine(command: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;

    let arg = '';
    let quoted = false;
    while (i < command.length) {
      let slashCount = 0;
      while (command[i] === '\\') {
        slashCount++;
        i++;
      }

      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 1) {
          arg += '"';
        } else if (quoted && command[i + 1] === '"') {
          // Double quote inside a quoted argument is a literal quote.
          arg += '"';
          i++;
        } else {
          quoted = !quoted;
        }
        i++;
        continue;
      }

      arg += '\\'.repeat(slashCount);
      if (i >= command.length || (!quoted && /\s/.test(command[i]))) break;
      arg += command[i++];
    }
    args.push(arg);
    while (i < command.length && /\s/.test(command[i])) i++;
  }
  return args;
}

function isWindowsAbsolute(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
}

/** Stable source-to-action key across slash styles, drive casing, and UNC prefixes. */
export function canonicalCompilePath(filePath: string, baseDir: string): string {
  let raw = filePath.replace(/^\\\\\?\\/, '');
  if (isWindowsAbsolute(raw)) {
    raw = path.win32.normalize(raw).replace(/\\/g, '/');
    return raw.toLowerCase();
  }
  raw = path.resolve(baseDir, raw);
  return raw.replace(/\\/g, '/').toLowerCase();
}

export function resolveCompilePath(filePath: string, directory: string | undefined, projectRoot: string): string {
  return canonicalCompilePath(filePath, directory || projectRoot);
}
