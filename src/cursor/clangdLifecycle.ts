import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface RestartState {
  fingerprint?: string;
  pending?: Promise<void>;
}

const states = new Map<string, RestartState>();

async function effectiveFingerprint(projectRoot: string): Promise<string> {
  const files = [
    path.join(projectRoot, 'compile_commands.json'),
    path.join(projectRoot, '.clangd'),
    path.join(projectRoot, '.ue5_8cursor', 'UHTIDEStubs.h'),
  ];
  const parts: string[] = [];
  for (const file of files) {
    try {
      const content = await fs.promises.readFile(file);
      parts.push(`${file}:${crypto.createHash('sha256').update(content).digest('hex')}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Coalesce all extension-originated restart requests. A server shutdown after
 * an unchanged DB is pure cache loss, so it is deliberately suppressed.
 */
export async function requestClangdRestart(
  projectRoot: string,
  reason: string,
  log?: (message: string) => void,
): Promise<boolean> {
  const root = path.resolve(projectRoot).toLowerCase();
  const fingerprint = await effectiveFingerprint(projectRoot);
  const state = states.get(root) ?? {};
  if (state.fingerprint === fingerprint) return false;
  if (state.pending) {
    await state.pending;
    const afterPending = await effectiveFingerprint(projectRoot);
    if (state.fingerprint === afterPending) return false;
    return requestClangdRestart(projectRoot, reason, log);
  }

  state.pending = new Promise<void>((resolve) => setTimeout(resolve, 300)).then(async () => {
    const current = await effectiveFingerprint(projectRoot);
    if (state.fingerprint === current) return;
    try {
      await vscode.commands.executeCommand('clangd.restart');
      state.fingerprint = current;
      log?.(`[UE5_8 Cursor] clangd restarted after ${reason}.`);
    } catch {
      log?.('[UE5_8 Cursor] clangd restart skipped: language server is inactive.');
    }
  }).finally(() => { state.pending = undefined; });
  states.set(root, state);
  await state.pending;
  const restarted = state.fingerprint === fingerprint;
  if (!restarted) {
    const latest = await effectiveFingerprint(projectRoot);
    if (state.fingerprint !== latest) {
      return requestClangdRestart(projectRoot, `${reason} (coalesced follow-up)`, log);
    }
  }
  return restarted;
}

export function resetClangdRestartState(projectRoot?: string): void {
  if (projectRoot) states.delete(path.resolve(projectRoot).toLowerCase());
  else states.clear();
}
