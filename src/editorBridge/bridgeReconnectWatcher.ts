import * as path from 'path';
import * as vscode from 'vscode';
import type { UE5_8CursorContext } from '../types';
import { EditorBridgeClient, formatBridgeStatus, type EditorBridgeInfo } from './editorBridgeClient';
import { readEditorBridgeDescriptor } from './editorBridgeRpc';

export interface BridgeReconnectWatcherOptions {
  listProjectRoots: () => string[];
  getBridge: (projectRoot: string) => EditorBridgeClient | undefined;
  getCtx: () => UE5_8CursorContext;
  onReconnect: (projectRoot: string, info: EditorBridgeInfo) => void | Promise<void>;
  onDisconnect: (projectRoot: string) => void;
  onEditorIdentityChanged?: (projectRoot: string) => void | Promise<void>;
  intervalMs?: number;
}

function descriptorIdentityKey(descriptor: { port: number; pid: number } | undefined): string | undefined {
  return descriptor ? `${descriptor.port}:${descriptor.pid}` : undefined;
}

/** Polls editor bridge handshakes for every registered project runtime. */
export function startBridgeReconnectWatcher(
  options: BridgeReconnectWatcherOptions,
): vscode.Disposable {
  const intervalMs = options.intervalMs ?? 15_000;
  const states = new Map<string, { wasConnected: boolean; lastDescriptorKey?: string; inFlight: boolean }>();

  const stateFor = (root: string) => {
    const key = root.toLowerCase();
    let state = states.get(key);
    if (!state) {
      state = { wasConnected: false, inFlight: false };
      states.set(key, state);
    }
    return state;
  };

  const timer = setInterval(() => {
    void (async () => {
      for (const root of options.listProjectRoots()) {
        const key = root.toLowerCase();
        const state = stateFor(root);
        if (state.inFlight) continue;
        const bridge = options.getBridge(root);
        if (!bridge) continue;

        state.inFlight = true;
        try {
          const ctx = options.getCtx();
          const descriptor = await readEditorBridgeDescriptor(root);
          const descriptorKey = descriptorIdentityKey(descriptor);

          if (state.wasConnected && bridge.isConnected() && descriptorKey && descriptorKey === state.lastDescriptorKey) {
            const alive = await bridge.ping(5_000);
            if (alive) continue;
          }

          const info = await bridge.connect(root, 10_000);
          const connected = info.connected;
          const identityChanged =
            connected && !!descriptorKey && !!state.lastDescriptorKey && descriptorKey !== state.lastDescriptorKey;

          if (connected && (!state.wasConnected || identityChanged)) {
            if (identityChanged) {
              ctx.outputChannel.appendLine(
                `[UE5_8 Cursor] Bridge editor identity changed (${state.lastDescriptorKey} -> ${descriptorKey}) — full resync`,
              );
              await options.onEditorIdentityChanged?.(root);
            } else {
              ctx.outputChannel.appendLine(`[UE5_8 Cursor] Bridge reconnected — ${formatBridgeStatus(info)}`);
            }
            await options.onReconnect(root, info);
          } else if (!connected && state.wasConnected) {
            ctx.outputChannel.appendLine(
              `[UE5_8 Cursor] Bridge disconnected (${path.basename(root)})${info.lastError ? `: ${info.lastError}` : ''}`,
            );
            options.onDisconnect(root);
          }
          state.wasConnected = connected;
          if (connected) {
            state.lastDescriptorKey = descriptorKey;
          } else {
            state.lastDescriptorKey = undefined;
          }
        } catch (err) {
          options.getCtx().outputChannel.appendLine(`[UE5_8 Cursor] Bridge reconnect poll failed (${root}): ${err}`);
        } finally {
          state.inFlight = false;
        }
      }
    })();
  }, intervalMs);

  return {
    dispose: () => {
      clearInterval(timer);
      states.clear();
    },
  };
}
