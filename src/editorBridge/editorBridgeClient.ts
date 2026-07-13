import * as vscode from 'vscode';
import type { UEProject } from '../types';
import {
  cacheBridgeToken,
  editorBridgeRpc,
  readEditorBridgeDescriptor,
  resolveBridgeToken,
  type EditorBridgeDescriptor,
  type EditorBridgeRpcOptions,
} from './editorBridgeRpc';
import {
  BRIDGE_CAPABILITIES,
  isMethodImplemented,
  type BridgeCapability,
  type BridgeMethod,
} from './bridgeProtocol';
import {
  bridgeFailure,
  bridgeSuccess,
  type BridgeConnectionState,
  type BridgeErrorKind,
  type BridgeResult,
} from './bridgeResult';

export type EditorBridgeCapability =
  | 'assetRegistry'
  | 'blueprintGraph'
  | 'pieState'
  | 'unrealLogs'
  | 'automationTests';

export interface EditorBridgeInfo {
  connected: boolean;
  endpoint?: string;
  capabilities: EditorBridgeCapability[];
  protocolVersion: number;
  state?: BridgeConnectionState;
  lastError?: string;
}

export class BridgeRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeRpcError';
  }
}

export interface BridgeAssetEntry {
  assetPath: string;
  className?: string;
  packageName?: string;
}

export interface BridgeAssetListResult {
  assets: BridgeAssetEntry[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
}

export interface BridgeBlueprintEntry {
  assetPath: string;
  parentClass?: string;
  authoritative?: boolean;
}

export interface AutomationStatus {
  state: 'running' | 'passed' | 'failed' | 'unknown' | 'cancelled';
  message?: string;
  durationMs?: number;
  line?: number;
  artifactPath?: string;
}

export interface BridgeUFunctionNode {
  assetPath: string;
  nodeName: string;
  graphName?: string;
  nodeX?: number;
  nodeY?: number;
}

export interface BridgeAutomationTest {
  name: string;
  source: 'automation' | 'spec';
  path?: string;
}

const CAPABILITY_MAP: Record<string, EditorBridgeCapability> = {
  assetRegistry: 'assetRegistry',
  blueprintGraph: 'blueprintGraph',
  pieState: 'pieState',
  unrealLogs: 'unrealLogs',
  automationTests: 'automationTests',
};

const OFFLINE_INFO: EditorBridgeInfo = {
  connected: false,
  capabilities: [],
  protocolVersion: 1,
};

export class EditorBridgeClient implements vscode.Disposable {
  private descriptor: EditorBridgeDescriptor | undefined;
  private info: EditorBridgeInfo = { ...OFFLINE_INFO };
  private readonly rpcOptions: EditorBridgeRpcOptions = { timeoutMs: 3000 };
  private connectionState: BridgeConnectionState = 'offline';
  private connectionGeneration = 0;
  private connectAbort: AbortController | undefined;
  private readonly activeRpcControllers = new Set<AbortController>();

  constructor(
    private projectRoot?: string,
    private readonly context?: vscode.ExtensionContext,
  ) {}

  getConnectionState(): BridgeConnectionState {
    return this.connectionState;
  }

  private isDisposed(): boolean {
    return this.connectionState === 'disposed';
  }

  private abortActiveRpcs(): void {
    for (const controller of this.activeRpcControllers) controller.abort();
    this.activeRpcControllers.clear();
  }

  async connect(projectRoot?: string, timeoutMs = 5000): Promise<EditorBridgeInfo> {
    if (this.isDisposed()) {
      return this.info;
    }
    const root = projectRoot ?? this.projectRoot;
    if (
      root
      && this.projectRoot === root
      && this.connectionState === 'connected'
      && this.descriptor
    ) {
      const alive = await this.ping(timeoutMs);
      if (alive) return this.info;
    }

    const gen = ++this.connectionGeneration;
    this.connectAbort?.abort();
    this.abortActiveRpcs();
    const controller = new AbortController();
    this.connectAbort = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (!root) {
      clearTimeout(timer);
      this.resetOffline('offline');
      return this.info;
    }
    this.projectRoot = root;
    this.connectionState = 'discovering';
    this.info = { ...this.info, connected: false, state: this.connectionState };

    const descriptor = await readEditorBridgeDescriptor(root);
    if (!descriptor) {
      clearTimeout(timer);
      if (gen === this.connectionGeneration) this.resetOffline('offline');
      return this.info;
    }

    this.connectionState = 'connecting';
    this.info = { ...this.info, state: this.connectionState };

    try {
      const token = await resolveBridgeToken(this.context, descriptor, root);
      const authedDescriptor = { ...descriptor, token };
      const result = (await editorBridgeRpc(
        authedDescriptor,
        'handshake',
        { client: 'ue58rider', version: 1 },
        { ...this.rpcOptions, timeoutMs, signal: controller.signal },
      )) as { ok?: boolean; capabilities?: string[] };

      if (gen !== this.connectionGeneration) return this.info;

      if (!result?.ok) {
        this.resetOffline('degraded', 'handshake rejected');
        return this.info;
      }

      await cacheBridgeToken(this.context, descriptor, root);
      this.descriptor = authedDescriptor;
      const caps = (result.capabilities ?? descriptor.capabilities)
        .map((c) => CAPABILITY_MAP[c])
        .filter((c): c is EditorBridgeCapability => !!c);

      this.connectionState = 'connected';
      this.info = {
        connected: true,
        endpoint: `http://127.0.0.1:${descriptor.port}`,
        capabilities: caps,
        protocolVersion: descriptor.protocolVersion,
        state: this.connectionState,
      };
      return this.info;
    } catch (err) {
      if (gen === this.connectionGeneration) {
        const kind = controller.signal.aborted ? 'timeout' : 'rpc';
        this.resetOffline('degraded', `${kind}: ${err}`);
      }
      return this.info;
    } finally {
      clearTimeout(timer);
    }
  }

  private async bridgeCall<T>(method: BridgeMethod, params?: unknown, timeoutMs?: number): Promise<BridgeResult<T>> {
    if (this.isDisposed()) {
      return bridgeFailure('disposed', 'Bridge disposed');
    }
    const descriptor = this.descriptor;
    if (!descriptor || this.connectionState !== 'connected') {
      return bridgeFailure('offline', 'Bridge offline');
    }
    if (!this.canCall(method)) {
      return bridgeFailure('unsupported', `Method unavailable: ${method}`);
    }
    const gen = this.connectionGeneration;
    const controller = new AbortController();
    this.activeRpcControllers.add(controller);
    const ms = timeoutMs ?? this.rpcOptions.timeoutMs ?? 3000;
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const result = await editorBridgeRpc(descriptor, method, params, {
        ...this.rpcOptions,
        timeoutMs: ms,
        signal: controller.signal,
      });
      if (gen !== this.connectionGeneration) {
        return bridgeFailure('aborted', 'Superseded connection');
      }
      if (this.isDisposed()) {
        return bridgeFailure('disposed', 'Bridge disposed');
      }
      return bridgeSuccess(result as T);
    } catch (err) {
      const kind: BridgeErrorKind = controller.signal.aborted ? 'timeout' : 'rpc';
      if (gen === this.connectionGeneration && !this.isDisposed()) {
        this.connectionState = 'degraded';
        this.info = { ...this.info, state: 'degraded', lastError: `${kind}: ${method}` };
      }
      return bridgeFailure(kind, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      this.activeRpcControllers.delete(controller);
    }
  }

  /** Lightweight handshake without tearing down an established connection. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    if (this.connectionState !== 'connected' || !this.descriptor) {
      return false;
    }
    const gen = this.connectionGeneration;
    const controller = new AbortController();
    this.activeRpcControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = (await editorBridgeRpc(
        this.descriptor,
        'handshake',
        { client: 'ue58rider', version: 1 },
        { ...this.rpcOptions, timeoutMs, signal: controller.signal },
      )) as { ok?: boolean };
      return gen === this.connectionGeneration && this.connectionState === 'connected' && !!result?.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.activeRpcControllers.delete(controller);
    }
  }

  canCall(method: BridgeMethod): boolean {
    if (!this.descriptor || !this.isAuthoritative()) return false;
    if (!isMethodImplemented(method)) return false;
    const cap = Object.entries(BRIDGE_CAPABILITIES).find(([, methods]) =>
      (methods as readonly BridgeMethod[]).includes(method),
    )?.[0] as BridgeCapability | undefined;
    if (!cap) return true;
    return this.hasCapability(cap);
  }

  getInfo(): EditorBridgeInfo {
    return this.info;
  }

  isAuthoritative(): boolean {
    return this.info.connected;
  }

  hasCapability(cap: BridgeCapability): boolean {
    return this.info.capabilities.includes(cap as EditorBridgeCapability);
  }

  async queryAssetsResult(options?: {
    path?: string;
    class?: string;
    limit?: number;
    offset?: number;
    filter?: string;
    timeoutMs?: number;
  }): Promise<BridgeResult<BridgeAssetListResult>> {
    const result = await this.bridgeCall<BridgeAssetListResult & { assets?: BridgeAssetEntry[] }>(
      'assetRegistry.list',
      { limit: 500, offset: 0, ...options },
      options?.timeoutMs,
    );
    if (!result.ok) return result;
    const page = result.value;
    return bridgeSuccess({
      assets: page.assets ?? [],
      total: page.total,
      hasMore: page.hasMore,
      offset: page.offset ?? options?.offset,
    }, !(page.assets?.length));
  }

  async queryAssets(options?: {
    path?: string;
    class?: string;
    limit?: number;
    offset?: number;
    filter?: string;
    timeoutMs?: number;
  }): Promise<BridgeAssetListResult> {
    const result = await this.queryAssetsResult(options);
    if (!result.ok) return { assets: [] };
    return result.value;
  }

  async queryAllAssetsResult(options?: {
    path?: string;
    class?: string;
    pageSize?: number;
    timeoutMs?: number;
  }): Promise<BridgeResult<BridgeAssetEntry[]>> {
    const pageSize = options?.pageSize ?? 500;
    const all: BridgeAssetEntry[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const pageResult = await this.queryAssetsResult({ ...options, limit: pageSize, offset });
      if (!pageResult.ok) return pageResult;
      const page = pageResult.value;
      all.push(...(page.assets ?? []));
      hasMore = !!page.hasMore && (page.assets?.length ?? 0) > 0;
      offset += page.assets?.length ?? 0;
      if (!page.assets?.length) break;
    }
    return bridgeSuccess(all, all.length === 0);
  }

  async queryAllAssets(options?: { path?: string; class?: string; pageSize?: number; timeoutMs?: number }): Promise<BridgeAssetEntry[]> {
    const result = await this.queryAllAssetsResult(options);
    return result.ok ? result.value : [];
  }

  async queryAssetDeltaResult(since = 0): Promise<BridgeResult<{ added: BridgeAssetEntry[]; removed: string[]; updated: BridgeAssetEntry[]; since: number }>> {
    const result = await this.bridgeCall<{
      added?: BridgeAssetEntry[];
      removed?: string[];
      updated?: BridgeAssetEntry[];
      since?: number;
      truncated?: boolean;
    }>('assetRegistry.delta', { since });
    if (!result.ok) return result;
    const value = {
      added: result.value.added ?? [],
      removed: result.value.removed ?? [],
      updated: result.value.updated ?? [],
      since: result.value.since ?? since,
    };
    return bridgeSuccess(value, value.added.length + value.removed.length + value.updated.length === 0);
  }

  async queryAssetDelta(since = 0): Promise<{ added: BridgeAssetEntry[]; removed: string[]; updated: BridgeAssetEntry[]; since: number }> {
    const result = await this.queryAssetDeltaResult(since);
    if (!result.ok) return { added: [], removed: [], updated: [], since };
    return result.value;
  }

  async getAssetReferencersResult(assetPath: string, depth = 1): Promise<BridgeResult<BridgeAssetEntry[]>> {
    const result = await this.bridgeCall<{ referencers?: BridgeAssetEntry[]; truncated?: boolean }>(
      'assetRegistry.referencers',
      { path: assetPath, depth },
    );
    if (!result.ok) return result;
    return bridgeSuccess(result.value.referencers ?? [], !(result.value.referencers?.length));
  }

  async getAssetReferencers(assetPath: string, depth = 1): Promise<BridgeAssetEntry[]> {
    const result = await this.getAssetReferencersResult(assetPath, depth);
    if (!result.ok) throw new BridgeRpcError(result.error.message);
    return result.value;
  }

  async getAssetDependenciesResult(assetPath: string): Promise<BridgeResult<BridgeAssetEntry[]>> {
    const result = await this.bridgeCall<{ dependencies?: BridgeAssetEntry[]; truncated?: boolean }>(
      'assetRegistry.dependencies',
      { path: assetPath },
    );
    if (!result.ok) return result;
    return bridgeSuccess(result.value.dependencies ?? [], !(result.value.dependencies?.length));
  }

  async getAssetDependencies(assetPath: string): Promise<BridgeAssetEntry[]> {
    const result = await this.getAssetDependenciesResult(assetPath);
    if (!result.ok) throw new BridgeRpcError(result.error.message);
    return result.value;
  }

  async listDerivedBlueprints(parentClass: string): Promise<BridgeBlueprintEntry[]> {
    const result = await this.bridgeCall<{ derived?: BridgeBlueprintEntry[]; blueprints?: BridgeBlueprintEntry[] }>(
      'blueprint.listDerived',
      { classPath: parentClass },
    );
    if (!result.ok) return [];
    const list = result.value.derived ?? result.value.blueprints ?? [];
    return list.map((b) => ({ ...b, authoritative: true }));
  }

  async tailLogsResult(lines = 200, offset = 0, fileId?: string): Promise<BridgeResult<string[]>> {
    const result = await this.bridgeCall<{ lines?: Array<{ text?: string } | string> }>('logs.tail', {
      lines,
      offset,
      fileId,
    });
    if (!result.ok) return result;
    const mapped = (result.value.lines ?? []).map((l) => (typeof l === 'string' ? l : l.text ?? '')).filter(Boolean);
    return bridgeSuccess(mapped, mapped.length === 0);
  }

  async tailLogs(lines = 200, offset = 0, fileId?: string): Promise<string[]> {
    const result = await this.tailLogsResult(lines, offset, fileId);
    return result.ok ? result.value : [];
  }

  async getPieState(): Promise<{ isPlaying: boolean; mode: string } | undefined> {
    const result = await this.bridgeCall<{ isPlaying: boolean; mode: string }>('pie.getState', {});
    return result.ok ? result.value : undefined;
  }

  async findBlueprintImplementations(classPath: string): Promise<BridgeBlueprintEntry[]> {
    const result = await this.bridgeCall<{ implementations?: BridgeBlueprintEntry[]; blueprints?: BridgeBlueprintEntry[] }>(
      'blueprint.findImplementations',
      { classPath },
    );
    if (!result.ok) return [];
    const list = result.value.implementations ?? result.value.blueprints ?? [];
    return list.map((b) => ({ ...b, authoritative: true }));
  }

  async getBlueprintPropertyOverrides(classPath: string): Promise<Array<{ property: string; value: string }>> {
    const result = await this.bridgeCall<{ overrides?: Array<{ property: string; value: string }> }>(
      'blueprint.propertyOverrides',
      { classPath },
    );
    return result.ok ? (result.value.overrides ?? []) : [];
  }

  async getBlueprintCompileErrorsResult(classPath?: string): Promise<BridgeResult<Array<{ assetPath: string; message: string }>>> {
    const result = await this.bridgeCall<{ errors?: Array<{ assetPath: string; message: string }> }>(
      'blueprint.compileErrors',
      classPath ? { classPath } : {},
    );
    if (!result.ok) return result;
    const errors = result.value.errors ?? [];
    return bridgeSuccess(errors, errors.length === 0);
  }

  async getBlueprintCompileErrors(classPath?: string): Promise<Array<{ assetPath: string; message: string }>> {
    const result = await this.getBlueprintCompileErrorsResult(classPath);
    return result.ok ? result.value : [];
  }

  async findUFunctionNodesResult(classPath: string, functionName: string): Promise<BridgeResult<{ nodes: BridgeUFunctionNode[]; truncated?: boolean; timedOut?: boolean }>> {
    const result = await this.bridgeCall<{ nodes?: BridgeUFunctionNode[]; truncated?: boolean; timedOut?: boolean }>(
      'blueprint.findUFunctionNodes',
      { classPath, functionName },
      60_000,
    );
    if (!result.ok) return result;
    return bridgeSuccess({
      nodes: result.value.nodes ?? [],
      truncated: result.value.truncated,
      timedOut: result.value.timedOut,
    }, !(result.value.nodes?.length));
  }

  async findUFunctionNodes(classPath: string, functionName: string): Promise<BridgeUFunctionNode[]> {
    const result = await this.findUFunctionNodesResult(classPath, functionName);
    return result.ok ? result.value.nodes : [];
  }

  isConnected(): boolean {
    return this.info.connected;
  }

  async pollAutomationStatus(
    name: string,
    options?: { timeoutMs?: number; token?: vscode.CancellationToken },
  ): Promise<AutomationStatus> {
    if (!this.canCall('automation.status')) {
      return { state: 'unknown', message: 'automation.status not implemented on Bridge' };
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (options?.token?.isCancellationRequested) {
        return { state: 'cancelled', message: 'Cancelled' };
      }
      const result = await this.bridgeCall<{
          state?: string;
          message?: string;
          durationMs?: number;
          line?: number;
          artifactPath?: string;
        }>('automation.status', { name });
        if (!result.ok) {
          await sleep(1000);
          continue;
        }
        const statusExtras = {
          message: result.value.message,
          durationMs: result.value.durationMs,
          line: result.value.line,
          artifactPath: result.value.artifactPath,
        };
        if (result.value.state === 'passed') return { state: 'passed', ...statusExtras };
        if (result.value.state === 'failed') return { state: 'failed', ...statusExtras };
        if (result.value.state === 'timedOut') {
          return {
            state: 'failed',
            ...statusExtras,
            message: result.value.message ?? statusExtras.message ?? 'Automation timed out',
          };
        }
        if (result.value.state === 'cancelled') return { state: 'cancelled', ...statusExtras };
        if (result.value.state === 'running') {
          await sleep(1000);
          continue;
        }
        return { state: 'unknown', message: result.value.message ?? `Unexpected status: ${result.value.state ?? 'none'}` };
    }
    return { state: 'unknown', message: 'Automation status timed out' };
  }

  async listAutomationTestsResult(): Promise<BridgeResult<BridgeAutomationTest[]>> {
    const result = await this.bridgeCall<{ tests?: BridgeAutomationTest[] }>('automation.list', {});
    if (!result.ok) return result;
    const tests = result.value.tests ?? [];
    return bridgeSuccess(tests, tests.length === 0);
  }

  async listAutomationTests(): Promise<BridgeAutomationTest[]> {
    const result = await this.listAutomationTestsResult();
    return result.ok ? result.value : [];
  }

  async runAutomationTest(name: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.descriptor || !this.isAuthoritative()) {
      return { ok: false, message: 'Editor Bridge offline' };
    }
    const result = await this.bridgeCall<{ ok?: boolean; message?: string }>('automation.run', { name });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: result.value.ok ?? false, message: result.value.message };
  }

  async cancelAutomationTest(name: string): Promise<{ ok: boolean }> {
    const result = await this.bridgeCall<{ ok?: boolean }>('automation.cancel', { name });
    if (!result.ok) return { ok: false };
    return { ok: result.value.ok ?? false };
  }

  dispose(): void {
    this.connectionGeneration++;
    this.connectionState = 'disconnecting';
    this.connectAbort?.abort();
    this.abortActiveRpcs();
    this.connectionState = 'disposed';
    this.resetOffline('disposed');
  }

  private resetOffline(state: BridgeConnectionState = 'offline', lastError?: string): void {
    this.descriptor = undefined;
    this.connectionState = state;
    this.info = { ...OFFLINE_INFO, state: this.connectionState, lastError };
  }
}

export function formatBridgeStatus(info: EditorBridgeInfo): string {
  if (info.connected) return `EditorBridge v${info.protocolVersion}`;
  if (info.state === 'degraded') return `EditorBridge: degraded${info.lastError ? ` (${info.lastError})` : ''}`;
  if (info.state === 'disposed') return 'EditorBridge: disposed';
  return 'EditorBridge: offline (MCP provisional)';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
