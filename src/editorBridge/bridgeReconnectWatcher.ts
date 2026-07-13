import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import { EditorBridgeClient, formatBridgeStatus, withBridgeTimeout, type EditorBridgeInfo } from './editorBridgeClient';

export interface BridgeReconnectWatcherOptions {
  getProjectRoot: () => string | undefined;
  getBridge: () => EditorBridgeClient | undefined;
  getCtx: () => UE5_8CursorContext;
  onReconnect: (info: EditorBridgeInfo) => void | Promise<void>;
  onDisconnect: () => void;
  intervalMs?: number;
}

/** Polls editor bridge handshake and refreshes dependents when connectivity changes. */
export function startBridgeReconnectWatcher(
  options: BridgeReconnectWatcherOptions,
): vscode.Disposable {
  let wasConnected = options.getBridge()?.isConnected() ?? false;
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
        const info = await withBridgeTimeout(bridge.connect(root), 10_000);
        if (!info) return;

        const connected = info.connected;

        if (connected && !wasConnected) {
          const ctx = options.getCtx();
          ctx.outputChannel.appendLine(`[UE5_8 Cursor] Bridge reconnected — ${formatBridgeStatus(info)}`);
          await options.onReconnect(info);
        } else if (!connected && wasConnected) {
          options.onDisconnect();
        }
        wasConnected = connected;
      } finally {
        pollInFlight = false;
      }
    })();
  }, intervalMs);

  return { dispose: () => clearInterval(timer) };
}
