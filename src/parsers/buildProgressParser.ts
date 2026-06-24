export interface BuildProgress {
  current: number;
  total: number;
  action?: string;
}

const PROGRESS_PATTERNS = [
  /\[(\d+)\s*\/\s*(\d+)\]/,
  /(\d+)\s+of\s+(\d+)/i,
  /Building\s+(\d+)\s*\/\s*(\d+)/i,
];

export function parseBuildProgress(line: string): BuildProgress | undefined {
  for (const pattern of PROGRESS_PATTERNS) {
    const m = line.match(pattern);
    if (m) {
      return { current: parseInt(m[1], 10), total: parseInt(m[2], 10), action: line.trim() };
    }
  }
  return undefined;
}
