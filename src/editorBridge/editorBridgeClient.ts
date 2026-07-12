import * as vscode from 'vscode';
import type { UEProject } from '../types';

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

const DEFAULT_CAPABILITIES: EditorBridgeCapability[] = [
  'assetRegistry',
  'blueprintGraph',
  'pieState',
  'unrealLogs',
];

export class EditorBridgeClient implements vscode.Disposable {
  private info: EditorBridgeInfo = {
    connected: false,
    capabilities: [],
    protocolVersion: 1,
  };

  constructor(private readonly project?: UEProject) {}

  async connect(): Promise<EditorBridgeInfo> {
    // Named pipe / WebSocket bridge is provided by the UE58CursorBridge editor plugin.
    // Until the plugin is running, callers should treat MCP results as provisional.
    this.info = {
      connected: false,
      capabilities: DEFAULT_CAPABILITIES,
      protocolVersion: 1,
    };
    return this.info;
  }

  getInfo(): EditorBridgeInfo {
    return this.info;
  }

  isAuthoritative(): boolean {
    return this.info.connected;
  }

  dispose(): void {
    this.info.connected = false;
  }
}

export function formatBridgeStatus(info: EditorBridgeInfo): string {
  return info.connected ? `EditorBridge v${info.protocolVersion}` : 'EditorBridge: offline (MCP provisional)';
}
