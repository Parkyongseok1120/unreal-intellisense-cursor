import * as fs from 'fs';

/** Lightweight UE package header reader — not full deserialization. */
export interface UassetHeaderInfo {
  packageName?: string;
  exportClassName?: string;
}

const UE3_MAGIC = 0x9e2a83c1;

function readLatin1Heuristic(buf: Buffer): UassetHeaderInfo | undefined {
  const text = buf.toString('latin1');
  const gameMatch = text.match(/\/Game\/[A-Za-z0-9_./-]+/);
  const classHints = ['Blueprint', 'Material', 'StaticMesh', 'SkeletalMesh', 'World', 'WidgetBlueprint'];
  let exportClassName: string | undefined;
  for (const hint of classHints) {
    if (text.includes(hint)) {
      exportClassName = hint;
      break;
    }
  }
  return {
    packageName: gameMatch?.[0],
    exportClassName,
  };
}

/** Attempt to read name table offset from UE5 package summary (best-effort). */
function readNameTableHeuristic(buf: Buffer): string[] {
  const names: string[] = [];
  if (buf.length < 64) return names;

  const nameOffset = buf.readInt32LE(12);
  if (nameOffset <= 0 || nameOffset >= buf.length - 8) return names;

  let pos = nameOffset;
  for (let i = 0; i < 32 && pos < buf.length - 4; i++) {
    const len = buf.readInt32LE(pos);
    if (len <= 0 || len > 256 || pos + 4 + len > buf.length) break;
    const raw = buf.subarray(pos + 4, pos + 4 + len);
    const s = raw.toString('utf8').replace(/\0/g, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) names.push(s);
    pos += 4 + len + 4;
  }
  return names;
}

export async function readUassetHeader(filePath: string): Promise<UassetHeaderInfo | undefined> {
  try {
    const buf = await fs.promises.readFile(filePath);
    if (buf.length < 32) return undefined;

    const magic = buf.readUInt32LE(0);
    if (magic !== UE3_MAGIC) return undefined;

    const latin = readLatin1Heuristic(buf);
    const nameTable = readNameTableHeuristic(buf);

    let exportClassName = latin?.exportClassName;
    if (!exportClassName) {
      const className = nameTable.find((n) =>
        ['Blueprint', 'Material', 'StaticMesh', 'World', 'WidgetBlueprint'].some((h) => n.includes(h)),
      );
      if (className) exportClassName = className;
    }

    return {
      packageName: latin?.packageName,
      exportClassName,
    };
  } catch {
    return undefined;
  }
}

export async function enrichEntryFromUasset(
  diskPath: string,
  assetName: string,
  inferredClass?: string,
): Promise<{ packageClass?: string; assetPath?: string }> {
  const header = await readUassetHeader(diskPath);
  if (!header) return {};
  return {
    packageClass: header.exportClassName ?? inferredClass,
    assetPath: header.packageName,
  };
}
