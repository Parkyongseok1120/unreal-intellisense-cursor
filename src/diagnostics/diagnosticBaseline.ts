import * as path from 'path';
import type { UbtBuildEvidence } from './ubtBuildEvidence';

export type DiagnosticOrigin = 'clangd' | 'uht' | 'ubt' | 'plugin' | 'engine-header' | 'heuristic' | 'external';
export type DiagnosticConfidence = 'authoritative' | 'advisory' | 'heuristic' | 'external';
export type UbtEvidence = 'matching-diagnostic' | 'not-observed' | 'not-applicable';

export interface DiagnosticInput {
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface DiagnosticBaselineEntry extends DiagnosticInput {
  origin: DiagnosticOrigin;
  confidence: DiagnosticConfidence;
  actionable: boolean;
  ubtEvidence: UbtEvidence;
}

export interface DiagnosticBaseline {
  version: 1;
  capturedAt: string;
  projectRoot: string;
  engineRoot?: string;
  ubtBuild?: UbtBuildEvidence;
  entries: DiagnosticBaselineEntry[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    actionable: number;
    byOrigin: Record<DiagnosticOrigin, number>;
  };
}

function normalized(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function isWithin(candidate: string, root: string | undefined): boolean {
  if (!root) return false;
  const c = normalized(candidate);
  const r = normalized(root).replace(/\/$/, '');
  return c === r || c.startsWith(`${r}/`);
}

function diagnosticCode(input: DiagnosticInput): string {
  return (input.code ?? '').toLowerCase();
}

export function classifyDiagnostic(
  input: DiagnosticInput,
  options: { projectRoot: string; engineRoot?: string },
): Omit<DiagnosticBaselineEntry, 'ubtEvidence'> {
  const source = (input.source ?? '').toLowerCase();
  const code = diagnosticCode(input);
  const inProject = isWithin(input.filePath, options.projectRoot);
  const inPlugin = inProject && /[\\/]plugins[\\/]/i.test(input.filePath);
  const inEngine = isWithin(input.filePath, options.engineRoot);

  if (source.includes('uht')) {
    return { ...input, origin: 'uht', confidence: 'authoritative', actionable: true };
  }
  if (source.includes('ubt') || source.includes('unrealbuildtool') || source === 'ue5_8 cursor') {
    return { ...input, origin: 'ubt', confidence: 'authoritative', actionable: true };
  }
  if (source.includes('inspection') || source.includes('heuristic')) {
    return { ...input, origin: 'heuristic', confidence: 'heuristic', actionable: false };
  }
  if (source.includes('clang')) {
    if (inEngine) {
      // Include Cleaner warnings from UE headers are not a project code action.
      const noise = code.includes('unused-includes') || /included header .* not used directly/i.test(input.message);
      return { ...input, origin: 'engine-header', confidence: 'advisory', actionable: !noise };
    }
    if (inPlugin) {
      return { ...input, origin: 'plugin', confidence: 'advisory', actionable: true };
    }
    return { ...input, origin: 'clangd', confidence: 'advisory', actionable: true };
  }

  return { ...input, origin: 'external', confidence: 'external', actionable: inProject };
}

function matchKey(entry: Pick<DiagnosticInput, 'filePath' | 'line'>): string {
  return `${normalized(entry.filePath)}:${entry.line}`;
}

export function createDiagnosticBaseline(
  inputs: DiagnosticInput[],
  options: { projectRoot: string; engineRoot?: string; capturedAt?: string; ubtBuild?: UbtBuildEvidence },
): DiagnosticBaseline {
  const ubtLocations = new Set(
    inputs
      .filter((entry) => classifyDiagnostic(entry, options).origin === 'ubt')
      .map(matchKey),
  );
  const entries = inputs.map((input) => {
    const classified = classifyDiagnostic(input, options);
    const ubtEvidence: UbtEvidence = classified.origin === 'clangd' || classified.origin === 'plugin'
      ? (ubtLocations.has(matchKey(input)) ? 'matching-diagnostic' : 'not-observed')
      : 'not-applicable';
    return { ...classified, ubtEvidence };
  });
  const byOrigin: Record<DiagnosticOrigin, number> = {
    clangd: 0,
    uht: 0,
    ubt: 0,
    plugin: 0,
    'engine-header': 0,
    heuristic: 0,
    external: 0,
  };
  for (const entry of entries) byOrigin[entry.origin]++;
  return {
    version: 1,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    projectRoot: options.projectRoot,
    engineRoot: options.engineRoot,
    ubtBuild: options.ubtBuild,
    entries,
    summary: {
      total: entries.length,
      errors: entries.filter((entry) => entry.severity === 'error').length,
      warnings: entries.filter((entry) => entry.severity === 'warning').length,
      actionable: entries.filter((entry) => entry.actionable).length,
      byOrigin,
    },
  };
}
