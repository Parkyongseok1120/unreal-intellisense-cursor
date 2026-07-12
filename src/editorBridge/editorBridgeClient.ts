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
  state: 'running' | 'passed' | 'failed' | 'unknown';
  message?: string;
}

export interface BridgeAutomationTest {
  name: string;
  source: 'automation' | 'spec';
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

  async queryAssets(options?: {
    path?: string;
    class?: string;
    limit?: number;
    offset?: number;
    filter?: string;
  }): Promise<BridgeAssetListResult> {
    if (!this.descriptor || !this.isAuthoritative()) return { assets: [] };
    try {
      const result = (await editorBridgeRpc(
        this.descriptor,
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

  async listDerivedBlueprints(parentClass: string): Promise<BridgeBlueprintEntry[]> {
    if (!this.descriptor || !this.isAuthoritative()) return [];
    try {
      const result = (await editorBridgeRpc(
        this.descriptor,
        'blueprint.listDerived',
        { parentClass },
        this.rpcOptions,
      )) as { blueprints?: BridgeBlueprintEntry[] };
      return (result.blueprints ?? []).map((b) => ({ ...b, authoritative: true }));
    } catch {
      return [];
    }
  }

  async findBlueprintImplementations(interfaceName: string): Promise<BridgeBlueprintEntry[]> {
    if (!this.descriptor || !this.isAuthoritative()) return [];
    try {
      const result = (await editorBridgeRpc(
        this.descriptor,
        'blueprint.findImplementations',
        { interfaceName },
        this.rpcOptions,
      )) as { blueprints?: BridgeBlueprintEntry[] };
      return (result.blueprints ?? []).map((b) => ({ ...b, authoritative: true }));
    } catch {
      return [];
    }
  }

  async getBlueprintPropertyOverrides(assetPath: string): Promise<Record<string, unknown>> {
    if (!this.descriptor || !this.isAuthoritative()) return {};
    try {
      const result = (await editorBridgeRpc(
        this.descriptor,
        'blueprint.propertyOverrides',
        { assetPath },
        this.rpcOptions,
      )) as { overrides?: Record<string, unknown> };
      return result.overrides ?? {};
    } catch {
      return {};
    }
  }

  async pollAutomationStatus(
    name: string,
    options?: { timeoutMs?: number; token?: vscode.CancellationToken },
  ): Promise<AutomationStatus> {
    if (!this.descriptor || !this.isAuthoritative()) {
      return { state: 'unknown', message: 'Editor Bridge offline' };
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (options?.token?.isCancellationRequested) {
        return { state: 'unknown', message: 'Cancelled' };
      }
      try {
        const result = (await editorBridgeRpc(this.descriptor, 'automation.status', { name }, this.rpcOptions)) as {
          state?: string;
          message?: string;
          ok?: boolean;
        };
        if (result.state === 'passed' || result.ok === true) return { state: 'passed' };
        if (result.state === 'failed') return { state: 'failed', message: result.message };
        if (result.state === 'running') {
          await sleep(1000);
          continue;
        }
        return { state: 'passed' };
      } catch (err) {
        return { state: 'unknown', message: err instanceof Error ? err.message : 'status poll failed' };
      }
    }
    return { state: 'unknown', message: 'Automation status timed out' };
  }

  async listAutomationTests(): Promise<BridgeAutomationTest[]> {
    if (!this.descriptor || !this.isAuthoritative()) return [];
    try {
      const result = (await editorBridgeRpc(this.descriptor, 'automation.list', {}, this.rpcOptions)) as {
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
