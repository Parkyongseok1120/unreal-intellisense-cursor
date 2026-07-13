import * as vscode from 'vscode';
import { logSilentFailure } from '../platform/silentFailure';

let dispatchChain: Promise<void> = Promise.resolve();
let activeProjectRoot: string | undefined;

export function getBridgeDispatchRoot(): string | undefined {
  return activeProjectRoot;
}

export function setBridgeDispatchRoot(projectRoot: string | undefined): void {
  activeProjectRoot = projectRoot;
}

/**
 * Serialize MCP/bridge command handlers that temporarily switch the active project
 * context so one project's authenticated endpoint cannot leak into another.
 */
export function runSerializedBridgeCommand(
  projectRoot: string,
  command: string,
  args: unknown[],
  outputChannel: vscode.OutputChannel | undefined,
): Promise<void> {
  const dispatch = dispatchChain.then(async () => {
    const previous = activeProjectRoot;
    activeProjectRoot = projectRoot;
    try {
      await vscode.commands.executeCommand(command, ...args);
    } finally {
      activeProjectRoot = previous;
    }
  });
  dispatchChain = dispatch.catch((err) => logSilentFailure(outputChannel, 'Bridge command dispatch failed', err));
  return dispatch;
}

export function resetBridgeCommandDispatch(): void {
  dispatchChain = Promise.resolve();
  activeProjectRoot = undefined;
}
