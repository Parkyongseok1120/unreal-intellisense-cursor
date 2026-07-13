import * as vscode from 'vscode';
import { CommandBridge } from '../mcp/commandBridge';

export type ProjectSessionState =
  | 'Idle'
  | 'Detecting'
  | 'LoadingProjectModel'
  | 'WarmingUHT'
  | 'Indexing'
  | 'Ready'
  | 'Invalidated'
  | 'Refreshing'
  | 'Failed';

export type JobKind = 'detection' | 'warmup' | 'compileRefresh' | 'reflection' | 'bridge';

export interface PipelineRunOptions {
  allowAutoSetup?: boolean;
}

type PipelineRunner = (options: PipelineRunOptions, token: vscode.CancellationToken) => Promise<void>;

const WRITE_JOBS: ReadonlySet<JobKind> = new Set(['warmup', 'compileRefresh']);

export class ProjectSession implements vscode.Disposable {
  private state: ProjectSessionState = 'Idle';
  private generation = 0;
  private pipelinePromise: Promise<void> | undefined;
  private cancelSource: vscode.CancellationTokenSource | undefined;
  private bridge: CommandBridge | undefined;
  private bridgeProjectRoot: string | undefined;
  private failureCount = 0;
  private writeJobChain: Promise<void> = Promise.resolve();
  private pendingInvalidations = new Set<string>();

  getState(): ProjectSessionState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  getActiveToken(): vscode.CancellationToken | undefined {
    return this.cancelSource?.token;
  }

  private setState(next: ProjectSessionState): void {
    this.state = next;
  }

  async runPipeline(runner: PipelineRunner, options: PipelineRunOptions = {}): Promise<void> {
    if (this.disposed) return;
    this.cancelSource?.cancel();
    this.cancelSource?.dispose();

    this.cancelSource = new vscode.CancellationTokenSource();
    const token = this.cancelSource.token;
    const gen = ++this.generation;

    this.setState('Detecting');
    const current = (async () => {
      try {
        await runner(options, token);
        if (token.isCancellationRequested || gen !== this.generation) return;
        this.setState('Ready');
        this.failureCount = 0;
      } catch (err) {
        if (token.isCancellationRequested || gen !== this.generation) return;
        this.setState('Failed');
        this.failureCount++;
        throw err;
      }
    })();

    this.pipelinePromise = current;
    try {
      await current;
    } finally {
      if (this.pipelinePromise === current) {
        this.pipelinePromise = undefined;
      }
    }
  }

  isStale(generation: number): boolean {
    return generation !== this.generation;
  }

  invalidate(): void {
    if (this.state === 'Ready') {
      this.setState('Invalidated');
    }
  }

  enqueueInvalidation(scope: string): void {
    this.pendingInvalidations.add(scope);
    this.invalidate();
  }

  drainInvalidations(): string[] {
    const scopes = [...this.pendingInvalidations];
    this.pendingInvalidations.clear();
    return scopes;
  }

  markRefreshing(): void {
    this.setState('Refreshing');
  }

  markLoadingProjectModel(): void {
    this.setState('LoadingProjectModel');
  }

  markWarmingUht(): void {
    this.setState('WarmingUHT');
  }

  markIndexing(): void {
    this.setState('Indexing');
  }

  getBackoffMs(): number {
    return Math.min(60_000, 1000 * 2 ** Math.min(this.failureCount, 6));
  }

  async awaitIdleWrites(): Promise<void> {
    await this.writeJobChain;
  }

  async runJob<T>(
    kind: JobKind,
    projectRoot: string,
    generation: number,
    token: vscode.CancellationToken,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.disposed) return undefined;
    const run = async (): Promise<T | undefined> => {
      if (token.isCancellationRequested || this.isStale(generation)) return undefined;
      const result = await fn();
      if (token.isCancellationRequested || this.isStale(generation)) return undefined;
      return result;
    };

    if (WRITE_JOBS.has(kind)) {
      const chained = this.writeJobChain.then(run, run);
      this.writeJobChain = chained.then(
        () => {},
        () => {},
      );
      return chained;
    }

    return run();
  }

  private bridgeStartPromise: Promise<CommandBridge | undefined> | undefined;
  private disposed = false;

  async ensureBridge(projectRoot: string): Promise<CommandBridge | undefined> {
    if (this.disposed) return undefined;
    if (this.bridgeStartPromise) return this.bridgeStartPromise;
    if (this.bridge && this.bridgeProjectRoot === projectRoot) return this.bridge;
    let inflight!: Promise<CommandBridge | undefined>;
    inflight = (async (): Promise<CommandBridge | undefined> => {
      this.bridge?.dispose();
      const bridge = new CommandBridge(projectRoot);
      this.bridge = bridge;
      this.bridgeProjectRoot = projectRoot;
      try {
        await bridge.start();
        if (this.disposed) {
          bridge.dispose();
          this.bridge = undefined;
          this.bridgeProjectRoot = undefined;
          return undefined;
        }
        return bridge;
      } catch {
        bridge.dispose();
        if (this.bridge === bridge) {
          this.bridge = undefined;
          this.bridgeProjectRoot = undefined;
        }
        return undefined;
      } finally {
        if (this.bridgeStartPromise === inflight) {
          this.bridgeStartPromise = undefined;
        }
      }
    })();
    this.bridgeStartPromise = inflight;
    return inflight;
  }

  getBridge(): CommandBridge | undefined {
    return this.bridge;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSource?.cancel();
    this.cancelSource?.dispose();
    this.cancelSource = undefined;
    this.bridgeStartPromise = undefined;
    this.bridge?.dispose();
    this.bridge = undefined;
    this.bridgeProjectRoot = undefined;
  }
}
