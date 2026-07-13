import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import { EditorBridgeClient, formatBridgeStatus, withBridgeTimeout, type EditorBridgeInfo } from './editorBridgeClient';
import { readEditorBridgeDescriptor } from './editorBridgeRpc';

export interface BridgeReconnectWatcherOptions {
  getProjectRoot: () => string | undefined;
  getBridge: () => EditorBridgeClient | undefined;
  getCtx: () => UE5_8CursorContext;
  onReconnect: (info: EditorBridgeInfo) => void | Promise<void>;
  onDisconnect: () => void;
  onEditorIdentityChanged?: (projectRoot: string) => void | Promise<void>;
  intervalMs?: number;
}

function descriptorIdentityKey(descriptor: { port: number; pid: number } | undefined): string | undefined {
  return descriptor ? `${descriptor.port}:${descriptor.pid}` : undefined;
}

/** Polls editor bridge handshake and refreshes dependents when connectivity changes. */
export function startBridgeReconnectWatcher(
  options: BridgeReconnectWatcherOptions,
): vscode.Disposable {
  let wasConnected = options.getBridge()?.isConnected() ?? false;
  let lastDescriptorKey: string | undefined;
  let pollInFlight = false;
  const intervalMs = options.intervalMs ?? 15_000;

  const timer = setInterval(() => {
    void (async () => {
      if (pollInFlight) return;
      const root = options.getProjectRoot();
      const bridge = options.getBridge();
      if (!root || !bridge) return;

      pollInFlight = true;
      try {
        const descriptor = await readEditorBridgeDescriptor(root);
        const descriptorKey = descriptorIdentityKey(descriptor);
        const info = await withBridgeTimeout(bridge.connect(root), 10_000);
        if (!info) return;

        const connected = info.connected;
        const identityChanged =
          connected && !!descriptorKey && !!lastDescriptorKey && descriptorKey !== lastDescriptorKey;

        if (connected && (!wasConnected || identityChanged)) {
          const ctx = options.getCtx();
          if (identityChanged) {
            ctx.outputChannel.appendLine(
              `[UE5_8 Cursor] Bridge editor identity changed (${lastDescriptorKey} -> ${descriptorKey}) — full resync`,
            );
            await options.onEditorIdentityChanged?.(root);
          } else {
            ctx.outputChannel.appendLine(`[UE5_8 Cursor] Bridge reconnected — ${formatBridgeStatus(info)}`);
          }
          await options.onReconnect(info);
        } else if (!connected && wasConnected) {
          options.onDisconnect();
        }
        wasConnected = connected;
        if (connected) {
          lastDescriptorKey = descriptorKey;
        } else {
          lastDescriptorKey = undefined;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, intervalMs);

  return { dispose: () => clearInterval(timer) };
}
