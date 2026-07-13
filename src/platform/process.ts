import { spawn } from 'child_process';
import type { CancellationToken } from 'vscode';
import type { SpawnResult } from '../types';

export async function isUnrealEditorRunning(): Promise<boolean> {
  const { findUnrealEditorProcesses } = await import('./debug');
  const processes = await findUnrealEditorProcesses();
  return processes.length > 0;
}

export function spawnAsync(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
    token?: CancellationToken;
    shell?: boolean;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      shell: options?.shell ?? false,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let stdoutRemainder = '';
    let stderrRemainder = '';

    if (options?.token) {
      const disposable = options.token.onCancellationRequested(() => {
        proc.kill('SIGTERM');
        disposable.dispose();
      });
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const lines = (stdoutRemainder + chunk).split('\n');
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stdout += trimmed + '\n';
        options?.onStdout?.(trimmed);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const lines = (stderrRemainder + chunk).split('\n');
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stderr += trimmed + '\n';
        options?.onStderr?.(trimmed);
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (stdoutRemainder) {
        stdout += stdoutRemainder + '\n';
        options?.onStdout?.(stdoutRemainder);
      }
      if (stderrRemainder) {
        stderr += stderrRemainder + '\n';
        options?.onStderr?.(stderrRemainder);
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
