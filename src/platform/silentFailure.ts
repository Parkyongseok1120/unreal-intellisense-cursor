import type * as vscode from 'vscode';

/** Log failures that were previously swallowed to keep pipelines alive. */
export function logSilentFailure(
  channel: vscode.OutputChannel | undefined,
  context: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  channel?.appendLine(`[UE5_8 Cursor] ${context}: ${message}`);
}
