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

  constructor(
    private projectRoot?: string,
    private readonly context?: vscode.ExtensionContext,
  ) {}

  async connect(projectRoot?: string): Promise<EditorBridgeInfo> {
    const root = projectRoot ?? this.projectRoot;
    if (!root) {
      this.resetOffline();
      return this.info;
    }
    this.projectRoot = root;

    const descriptor = await readEditorBridgeDescriptor(root);
    if (!descriptor) {
      this.resetOffline();
      return this.info;
    }

    try {
      const token = await resolveBridgeToken(this.context, descriptor, root);
      const authedDescriptor = { ...descriptor, token };
      const result = (await editorBridgeRpc(
        authedDescriptor,
        'handshake',
        { client: 'ue58rider', version: 1 },
        this.rpcOptions,
      )) as { ok?: boolean; capabilities?: string[] };

      if (!result?.ok) {
        this.resetOffline();
        return this.info;
      }

      await cacheBridgeToken(this.context, descriptor, root);
      this.descriptor = authedDescriptor;
      const caps = (result.capabilities ?? descriptor.capabilities)
        .map((c) => CAPABILITY_MAP[c])
        .filter((c): c is EditorBridgeCapability => !!c);

      this.info = {
        connected: true,
        endpoint: `http://127.0.0.1:${descriptor.port}`,
        capabilities: caps,
        protocolVersion: descriptor.protocolVersion,
      };
      return this.info;
    } catch {
      this.resetOffline();
      return this.info;
    }
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

  private canCall(method: BridgeMethod): boolean {
    if (!this.descriptor || !this.isAuthoritative()) return false;
    if (!isMethodImplemented(method)) return false;
    const cap = Object.entries(BRIDGE_CAPABILITIES).find(([, methods]) =>
      (methods as readonly BridgeMethod[]).includes(method),
    )?.[0] as BridgeCapability | undefined;
    if (!cap) return true;
    return this.hasCapability(cap);
  }

  async queryAssets(options?: {
    path?: string;
    class?: string;
    limit?: number;
    offset?: number;
    filter?: string;
  }): Promise<BridgeAssetListResult> {
    const descriptor = this.descriptor;
    if (!this.canCall('assetRegistry.list') || !descriptor) return { assets: [] };
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'assetRegistry.list',
        { limit: 500, offset: 0, ...options },
        this.rpcOptions,
      )) as BridgeAssetListResult & { assets?: BridgeAssetEntry[] };
      return {
        assets: result.assets ?? [],
        total: result.total,
        hasMore: result.hasMore,
        offset: result.offset ?? options?.offset,
      };
    } catch {
      return { assets: [] };
    }
  }

  async queryAllAssets(options?: { path?: string; class?: string; pageSize?: number }): Promise<BridgeAssetEntry[]> {
    const pageSize = options?.pageSize ?? 500;
    const all: BridgeAssetEntry[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await this.queryAssets({ ...options, limit: pageSize, offset });
      all.push(...(page.assets ?? []));
      hasMore = !!page.hasMore && (page.assets?.length ?? 0) > 0;
      offset += page.assets?.length ?? 0;
      if (!page.assets?.length) break;
    }
    return all;
  }

  async queryAssetDelta(since = 0): Promise<{ added: BridgeAssetEntry[]; removed: string[]; updated: BridgeAssetEntry[]; since: number }> {
    const descriptor = this.descriptor;
    if (!this.canCall('assetRegistry.delta') || !descriptor) {
      return { added: [], removed: [], updated: [], since };
    }
    try {
      const result = (await editorBridgeRpc(descriptor, 'assetRegistry.delta', { since }, this.rpcOptions)) as {
        added?: BridgeAssetEntry[];
        removed?: string[];
        updated?: BridgeAssetEntry[];
        since?: number;
      };
      return {
        added: result.added ?? [],
        removed: result.removed ?? [],
        updated: result.updated ?? [],
        since: result.since ?? since,
      };
    } catch {
      return { added: [], removed: [], updated: [], since };
    }
  }

  async getAssetReferencers(assetPath: string, depth = 1): Promise<BridgeAssetEntry[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('assetRegistry.referencers') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'assetRegistry.referencers',
        { path: assetPath, depth },
        this.rpcOptions,
      )) as { referencers?: BridgeAssetEntry[] };
      return result.referencers ?? [];
    } catch {
      return [];
    }
  }

  async getAssetDependencies(assetPath: string): Promise<BridgeAssetEntry[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('assetRegistry.dependencies') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'assetRegistry.dependencies',
        { path: assetPath },
        this.rpcOptions,
      )) as { dependencies?: BridgeAssetEntry[] };
      return result.dependencies ?? [];
    } catch {
      return [];
    }
  }

  async listDerivedBlueprints(parentClass: string): Promise<BridgeBlueprintEntry[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('blueprint.listDerived') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'blueprint.listDerived',
        { classPath: parentClass },
        this.rpcOptions,
      )) as { derived?: BridgeBlueprintEntry[]; blueprints?: BridgeBlueprintEntry[] };
      const list = result.derived ?? result.blueprints ?? [];
      return list.map((b) => ({ ...b, authoritative: true }));
    } catch {
      return [];
    }
  }

  async tailLogs(lines = 200): Promise<string[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('logs.tail') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(descriptor, 'logs.tail', { lines }, this.rpcOptions)) as {
        lines?: Array<{ text?: string } | string>;
      };
      return (result.lines ?? []).map((l) => (typeof l === 'string' ? l : l.text ?? '')).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getPieState(): Promise<{ isPlaying: boolean; mode: string } | undefined> {
    const descriptor = this.descriptor;
    if (!this.canCall('pie.getState') || !descriptor) return undefined;
    try {
      return (await editorBridgeRpc(descriptor, 'pie.getState', {}, this.rpcOptions)) as {
        isPlaying: boolean;
        mode: string;
      };
    } catch {
      return undefined;
    }
  }

  async findBlueprintImplementations(classPath: string): Promise<BridgeBlueprintEntry[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('blueprint.findImplementations') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'blueprint.findImplementations',
        { classPath },
        this.rpcOptions,
      )) as { implementations?: BridgeBlueprintEntry[]; blueprints?: BridgeBlueprintEntry[] };
      const list = result.implementations ?? result.blueprints ?? [];
      return list.map((b) => ({ ...b, authoritative: true }));
    } catch {
      return [];
    }
  }

  async getBlueprintPropertyOverrides(classPath: string): Promise<Array<{ property: string; value: string }>> {
    const descriptor = this.descriptor;
    if (!this.canCall('blueprint.propertyOverrides') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'blueprint.propertyOverrides',
        { classPath },
        this.rpcOptions,
      )) as { overrides?: Array<{ property: string; value: string }> };
      return result.overrides ?? [];
    } catch {
      return [];
    }
  }

  async getBlueprintCompileErrors(classPath?: string): Promise<Array<{ assetPath: string; message: string }>> {
    const descriptor = this.descriptor;
    if (!this.canCall('blueprint.compileErrors') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'blueprint.compileErrors',
        classPath ? { classPath } : {},
        this.rpcOptions,
      )) as { errors?: Array<{ assetPath: string; message: string }> };
      return result.errors ?? [];
    } catch {
      return [];
    }
  }

  async findUFunctionNodes(classPath: string, functionName: string): Promise<BridgeUFunctionNode[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('blueprint.findUFunctionNodes') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(
        descriptor,
        'blueprint.findUFunctionNodes',
        { classPath, functionName },
        { ...this.rpcOptions, timeoutMs: 60_000 },
      )) as { nodes?: BridgeUFunctionNode[] };
      return result.nodes ?? [];
    } catch {
      return [];
    }
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
      try {
        const result = (await editorBridgeRpc(this.descriptor!, 'automation.status', { name }, this.rpcOptions)) as {
          state?: string;
          message?: string;
          durationMs?: number;
          line?: number;
          artifactPath?: string;
        };
        const statusExtras = {
          message: result.message,
          durationMs: result.durationMs,
          line: result.line,
          artifactPath: result.artifactPath,
        };
        if (result.state === 'passed') return { state: 'passed', ...statusExtras };
        if (result.state === 'failed') return { state: 'failed', ...statusExtras };
        if (result.state === 'timedOut') {
          return { state: 'failed', message: result.message ?? 'Automation timed out', ...statusExtras };
        }
        if (result.state === 'cancelled') return { state: 'cancelled', ...statusExtras };
        if (result.state === 'running') {
          await sleep(1000);
          continue;
        }
        return { state: 'unknown', message: result.message ?? `Unexpected status: ${result.state ?? 'none'}` };
      } catch (err) {
        await sleep(1000);
        if (Date.now() - started >= timeoutMs) {
          return { state: 'unknown', message: err instanceof Error ? err.message : 'status poll failed' };
        }
      }
    }
    return { state: 'unknown', message: 'Automation status timed out' };
  }

  async cancelAutomationTest(name: string): Promise<{ ok: boolean }> {
    if (!this.canCall('automation.cancel')) return { ok: false };
    try {
      const result = (await editorBridgeRpc(this.descriptor!, 'automation.cancel', { name }, this.rpcOptions)) as {
        ok?: boolean;
      };
      return { ok: result.ok ?? false };
    } catch {
      return { ok: false };
    }
  }

  async listAutomationTests(): Promise<BridgeAutomationTest[]> {
    const descriptor = this.descriptor;
    if (!this.canCall('automation.list') || !descriptor) return [];
    try {
      const result = (await editorBridgeRpc(descriptor, 'automation.list', {}, this.rpcOptions)) as {
        tests?: BridgeAutomationTest[];
      };
      return result.tests ?? [];
    } catch {
      return [];
    }
  }

  async runAutomationTest(name: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.descriptor || !this.isAuthoritative()) {
      return { ok: false, message: 'Editor Bridge offline' };
    }
    try {
      const result = (await editorBridgeRpc(this.descriptor, 'automation.run', { name }, this.rpcOptions)) as {
        ok?: boolean;
        message?: string;
      };
      return { ok: result.ok ?? false, message: result.message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Automation run failed' };
    }
  }

  dispose(): void {
    this.resetOffline();
  }

  private resetOffline(): void {
    this.descriptor = undefined;
    this.info = { ...OFFLINE_INFO };
  }
}

export function formatBridgeStatus(info: EditorBridgeInfo): string {
  return info.connected ? `EditorBridge v${info.protocolVersion}` : 'EditorBridge: offline (MCP provisional)';
}

export function withBridgeTimeout<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
