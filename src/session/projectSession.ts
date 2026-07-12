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

export interface PipelineRunOptions {
  allowAutoSetup?: boolean;
}

type PipelineRunner = (options: PipelineRunOptions, token: vscode.CancellationToken) => Promise<void>;

export class ProjectSession implements vscode.Disposable {
  private state: ProjectSessionState = 'Idle';
  private generation = 0;
  private pipelinePromise: Promise<void> | undefined;
  private cancelSource: vscode.CancellationTokenSource | undefined;
  private bridge: CommandBridge | undefined;
  private bridgeProjectRoot: string | undefined;
  private failureCount = 0;

  getState(): ProjectSessionState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  private setState(next: ProjectSessionState): void {
    this.state = next;
  }

  async runPipeline(runner: PipelineRunner, options: PipelineRunOptions = {}): Promise<void> {
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

  async ensureBridge(projectRoot: string): Promise<CommandBridge | undefined> {
    if (this.bridge && this.bridgeProjectRoot === projectRoot) {
      return this.bridge;
    }
    this.bridge?.dispose();
    this.bridge = new CommandBridge(projectRoot);
    this.bridgeProjectRoot = projectRoot;
    try {
      await this.bridge.start();
      return this.bridge;
    } catch {
      this.bridge.dispose();
      this.bridge = undefined;
      this.bridgeProjectRoot = undefined;
      return undefined;
    }
  }

  getBridge(): CommandBridge | undefined {
    return this.bridge;
  }

  dispose(): void {
    this.cancelSource?.cancel();
    this.cancelSource?.dispose();
    this.cancelSource = undefined;
    this.bridge?.dispose();
    this.bridge = undefined;
    this.bridgeProjectRoot = undefined;
  }
}
