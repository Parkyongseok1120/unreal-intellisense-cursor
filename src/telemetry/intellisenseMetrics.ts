import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXTENSION_DATA_DIR } from '../constants';
import { mutateJson } from '../platform/workspaceMutation';
import { spawnAsync } from '../platform/process';
import type { CompileDbIndexPlan } from '../cursor/bootstrapProject';

export type IntelliSenseIndexPhase =
  | 'project-model-ready'
  | 'project-source-indexing'
  | 'project-usable'
  | 'plugin-indexing'
  | 'fully-indexed';

export interface ClangdProcessSample {
  pid: number;
  workingSetBytes: number;
  privateBytes: number;
  cpuSeconds?: number;
  matchedProject: boolean;
}

export interface IndexCacheProbe {
  files: number;
  newestMtimeMs?: number;
}

export interface IntelliSenseMetricSample {
  at: string;
  elapsedMs: number;
  workingSetBytes: number;
  privateBytes: number;
  processCount: number;
  cacheFiles: number;
  cacheNewestMtimeMs?: number;
}

export interface IntelliSenseMetrics {
  version: 1;
  runId: string;
  projectRoot: string;
  startedAt: string;
  finishedAt?: string;
  phase: IntelliSenseIndexPhase;
  plan?: CompileDbIndexPlan;
  timings: {
    compileDatabaseMs?: number;
    projectModelReadyMs?: number;
    projectUsableMs?: number;
    fullyIndexedMs?: number;
    pluginPromotionMs?: number[];
    firstDefinitionMs?: number[];
    warmDefinitionMs?: number[];
  };
  peak: {
    workingSetBytes: number;
    privateBytes: number;
  };
  cache: {
    initial: IndexCacheProbe;
    latest: IndexCacheProbe;
    fullIndexHeuristic: boolean;
  };
  resourceProfile: {
    installedMemoryBytes: number;
    availableMemoryBytes: number;
    profile: '16gb' | '32gb' | '64gb+';
  };
  acceptance: {
    projectUsable: 'pass' | 'fail' | 'pending';
    fullyIndexed: 'pass' | 'fail' | 'pending';
    privateMemory: 'pass' | 'fail' | 'pending';
    warmDefinition: 'pass' | 'fail' | 'pending';
  };
  samples: IntelliSenseMetricSample[];
}

export const Gate4PerformanceTargets = {
  projectUsableMs: 90_000,
  fullyIndexedMs: 5 * 60_000,
  privateMemoryBytes: 4 * 1024 ** 3,
  warmDefinitionMs: 1_000,
} as const;

export interface MetricsProbe {
  processes(projectRoot: string): Promise<ClangdProcessSample[]>;
  indexCache(projectRoot: string): Promise<IndexCacheProbe>;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function resultFor(value: number | undefined, target: number): 'pass' | 'fail' | 'pending' {
  if (value === undefined) return 'pending';
  return value <= target ? 'pass' : 'fail';
}

function cacheRoot(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'clangd', 'index');
}

async function scanIndexCache(dir: string, depth = 0): Promise<IndexCacheProbe> {
  if (depth > 4) return { files: 0 };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: 0 };
  }
  let files = 0;
  let newestMtimeMs: number | undefined;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanIndexCache(full, depth + 1);
      files += nested.files;
      if ((nested.newestMtimeMs ?? 0) > (newestMtimeMs ?? 0)) newestMtimeMs = nested.newestMtimeMs;
    } else if (entry.isFile()) {
      files++;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs > (newestMtimeMs ?? 0)) newestMtimeMs = stat.mtimeMs;
      } catch {
        // index shards can disappear while clangd replaces them
      }
    }
  }
  return { files, newestMtimeMs };
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw.trim()) return [];
  try {
    const value = JSON.parse(raw) as T | T[];
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

export async function probeClangdProcesses(projectRoot: string): Promise<ClangdProcessSample[]> {
  const normalizedRoot = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
  if (process.platform === 'win32') {
    const command = [
      "Get-CimInstance Win32_Process -Filter \"Name = 'clangd.exe'\"",
      'Select-Object ProcessId,CommandLine,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    try {
      const result = await spawnAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
      if (result.exitCode !== 0) return [];
      const records = parseJsonArray<{
        ProcessId?: number;
        CommandLine?: string;
        WorkingSetSize?: number | string;
        PrivatePageCount?: number | string;
        KernelModeTime?: number | string;
        UserModeTime?: number | string;
      }>(result.stdout);
      return records.map((record) => {
        const commandLine = (record.CommandLine ?? '').replace(/\\/g, '/').toLowerCase();
        const kernel = Number(record.KernelModeTime ?? 0);
        const user = Number(record.UserModeTime ?? 0);
        return {
          pid: Number(record.ProcessId ?? 0),
          workingSetBytes: Number(record.WorkingSetSize ?? 0),
          privateBytes: Number(record.PrivatePageCount ?? 0),
          cpuSeconds: Number.isFinite(kernel + user) ? (kernel + user) / 10_000_000 : undefined,
          matchedProject: commandLine.includes(normalizedRoot),
        };
      }).filter((record) => record.pid > 0);
    } catch {
      return [];
    }
  }

  try {
    const result = await spawnAsync('ps', ['-axo', 'pid=,rss=,comm=,args=']);
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!match || !/clangd/i.test(match[3])) return [];
      return [{
        pid: Number(match[1]),
        workingSetBytes: Number(match[2]) * 1024,
        privateBytes: 0,
        matchedProject: match[4].replace(/\\/g, '/').toLowerCase().includes(normalizedRoot),
      }];
    });
  } catch {
    return [];
  }
}

export const defaultMetricsProbe: MetricsProbe = {
  processes: probeClangdProcesses,
  indexCache: async (projectRoot) => scanIndexCache(cacheRoot(projectRoot)),
};

export class IntelliSenseMetricsTracker {
  private readonly startedMs: number;
  private readonly initialCachePromise: Promise<IndexCacheProbe>;
  private readonly metrics: IntelliSenseMetrics;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCacheMutationMs: number | undefined;
  private completed = false;

  constructor(
    readonly projectRoot: string,
    private readonly options: {
      probe?: MetricsProbe;
      now?: () => number;
      onPhase?: (phase: IntelliSenseIndexPhase, metrics: IntelliSenseMetrics) => void;
    } = {},
  ) {
    const now = this.now();
    this.startedMs = now;
    this.initialCachePromise = this.probe.indexCache(projectRoot);
    this.metrics = {
      version: 1,
      runId: `${now}-${Math.random().toString(16).slice(2, 10)}`,
      projectRoot,
      startedAt: nowIso(() => this.now()),
      phase: 'project-model-ready',
      timings: {},
      peak: { workingSetBytes: 0, privateBytes: 0 },
      cache: { initial: { files: 0 }, latest: { files: 0 }, fullIndexHeuristic: false },
      resourceProfile: {
        installedMemoryBytes: os.totalmem(),
        availableMemoryBytes: os.freemem(),
        profile: recommendedMetricsProfile(os.totalmem()),
      },
      acceptance: {
        projectUsable: 'pending',
        fullyIndexed: 'pending',
        privateMemory: 'pending',
        warmDefinition: 'pending',
      },
      samples: [],
    };
  }

  private get probe(): MetricsProbe { return this.options.probe ?? defaultMetricsProbe; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private elapsed(): number { return this.now() - this.startedMs; }

  async start(): Promise<void> {
    this.metrics.cache.initial = await this.initialCachePromise;
    this.metrics.cache.latest = this.metrics.cache.initial;
    this.lastCacheMutationMs = this.metrics.cache.initial.newestMtimeMs;
    await this.sample();
    this.timer = setInterval(() => void this.sample(), 2_000);
  }

  markCompileDatabaseReady(): void {
    this.metrics.timings.compileDatabaseMs ??= this.elapsed();
  }

  markProjectModelReady(plan: CompileDbIndexPlan): void {
    this.metrics.plan = plan;
    this.metrics.timings.projectModelReadyMs ??= this.elapsed();
    this.setPhase('project-source-indexing');
  }

  markProjectUsable(definitionMs?: number): void {
    this.metrics.timings.projectUsableMs ??= this.elapsed();
    if (definitionMs !== undefined) {
      this.metrics.timings.firstDefinitionMs?.push(definitionMs) ?? (this.metrics.timings.firstDefinitionMs = [definitionMs]);
    }
    this.refreshAcceptance();
    if (this.metrics.phase !== 'fully-indexed') this.setPhase('project-usable');
  }

  recordWarmDefinitionTiming(definitionMs?: number): void {
    if (definitionMs === undefined) return;
    this.metrics.timings.warmDefinitionMs?.push(definitionMs) ?? (this.metrics.timings.warmDefinitionMs = [definitionMs]);
    this.refreshAcceptance();
  }

  markPluginPromotion(durationMs?: number): void {
    if (durationMs !== undefined) this.metrics.timings.pluginPromotionMs?.push(durationMs) ?? (this.metrics.timings.pluginPromotionMs = [durationMs]);
    if (this.metrics.phase !== 'fully-indexed') this.setPhase('plugin-indexing');
  }

  private setPhase(phase: IntelliSenseIndexPhase): void {
    if (this.metrics.phase === phase) return;
    this.metrics.phase = phase;
    this.options.onPhase?.(phase, this.snapshot());
  }

  async sample(): Promise<void> {
    if (this.completed) return;
    const [processes, cache] = await Promise.all([this.probe.processes(this.projectRoot), this.probe.indexCache(this.projectRoot)]);
    const matched = processes.filter((process) => process.matchedProject);
    const selected = matched.length > 0 ? matched : processes.length === 1 ? processes : [];
    const workingSetBytes = selected.reduce((sum, process) => sum + process.workingSetBytes, 0);
    const privateBytes = selected.reduce((sum, process) => sum + process.privateBytes, 0);
    this.metrics.peak.workingSetBytes = Math.max(this.metrics.peak.workingSetBytes, workingSetBytes);
    this.metrics.peak.privateBytes = Math.max(this.metrics.peak.privateBytes, privateBytes);
    this.refreshAcceptance();
    this.metrics.cache.latest = cache;
    if ((cache.newestMtimeMs ?? 0) > (this.lastCacheMutationMs ?? 0)) this.lastCacheMutationMs = cache.newestMtimeMs;
    this.metrics.samples.push({
      at: nowIso(() => this.now()),
      elapsedMs: this.elapsed(),
      workingSetBytes,
      privateBytes,
      processCount: selected.length,
      cacheFiles: cache.files,
      cacheNewestMtimeMs: cache.newestMtimeMs,
    });
    if (this.metrics.samples.length > 180) this.metrics.samples.shift();

    // clangd does not expose index completion through a stable public VS Code
    // API. Cache inactivity is deliberately labelled a heuristic, not truth.
    const cacheQuietForMs = this.lastCacheMutationMs === undefined ? 0 : this.now() - this.lastCacheMutationMs;
    if (this.elapsed() >= 20_000 && cache.files > 0 && cacheQuietForMs >= 15_000) {
      this.metrics.cache.fullIndexHeuristic = true;
      this.metrics.timings.fullyIndexedMs ??= this.elapsed();
      this.refreshAcceptance();
      this.setPhase('fully-indexed');
      await this.finish();
    }
  }

  snapshot(): IntelliSenseMetrics {
    this.refreshAcceptance();
    return JSON.parse(JSON.stringify(this.metrics)) as IntelliSenseMetrics;
  }

  private refreshAcceptance(): void {
    const warmSamples = this.metrics.timings.warmDefinitionMs;
    const warmDefinition = warmSamples?.[warmSamples.length - 1];
    this.metrics.acceptance = {
      projectUsable: resultFor(this.metrics.timings.projectUsableMs, Gate4PerformanceTargets.projectUsableMs),
      fullyIndexed: resultFor(this.metrics.timings.fullyIndexedMs, Gate4PerformanceTargets.fullyIndexedMs),
      privateMemory: this.metrics.peak.privateBytes === 0
        ? 'pending'
        : resultFor(this.metrics.peak.privateBytes, Gate4PerformanceTargets.privateMemoryBytes),
      warmDefinition: resultFor(warmDefinition, Gate4PerformanceTargets.warmDefinitionMs),
    };
  }

  async save(): Promise<string> {
    const filePath = path.join(this.projectRoot, EXTENSION_DATA_DIR, 'metrics', `intellisense-${this.metrics.runId}.json`);
    await mutateJson(undefined, this.projectRoot, filePath, this.snapshot());
    return filePath;
  }

  async finish(): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.metrics.finishedAt = nowIso(() => this.now());
    await this.save();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const trackers = new Map<string, IntelliSenseMetricsTracker>();

export function startIntelliSenseMetricsRun(
  projectRoot: string,
  options?: ConstructorParameters<typeof IntelliSenseMetricsTracker>[1],
): IntelliSenseMetricsTracker {
  const key = path.resolve(projectRoot).toLowerCase();
  const previous = trackers.get(key);
  previous?.dispose();
  const tracker = new IntelliSenseMetricsTracker(projectRoot, options);
  trackers.set(key, tracker);
  // Metrics must never delay clangd bootstrap. Sampling starts independently.
  void tracker.start();
  return tracker;
}

export function getIntelliSenseMetricsTracker(projectRoot: string): IntelliSenseMetricsTracker | undefined {
  return trackers.get(path.resolve(projectRoot).toLowerCase());
}

export function disposeIntelliSenseMetrics(projectRoot?: string): void {
  if (projectRoot) {
    const key = path.resolve(projectRoot).toLowerCase();
    trackers.get(key)?.dispose();
    trackers.delete(key);
    return;
  }
  for (const tracker of trackers.values()) tracker.dispose();
  trackers.clear();
}

export function recommendedMetricsProfile(totalMemory = os.totalmem()): '16gb' | '32gb' | '64gb+' {
  const gib = 1024 ** 3;
  return totalMemory < 24 * gib ? '16gb' : totalMemory < 48 * gib ? '32gb' : '64gb+';
}
