import { spawn } from 'child_process';
import type { CancellationToken } from 'vscode';
import type { SpawnResult } from '../types';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export async function isUnrealEditorRunning(): Promise<boolean> {
  const { findUnrealEditorProcesses } = await import('./debug');
  const processes = await findUnrealEditorProcesses();
  return processes.length > 0;
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' })
        .on('close', () => resolve())
        .on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already exited
  }
}

function appendRingCapture(line: string, maxBytes: number, bytes: { value: number }, chunks: string[]): string {
  const addition = line + '\n';
  const additionBytes = Buffer.byteLength(addition, 'utf8');
  chunks.push(addition);
  bytes.value += additionBytes;
  while (bytes.value > maxBytes && chunks.length > 1) {
    const removed = chunks.shift()!;
    bytes.value -= Buffer.byteLength(removed, 'utf8');
  }
  return chunks.join('');
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
    maxCaptureBytes?: number;
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
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutRingBytes = { value: 0 };
    const stderrRingBytes = { value: 0 };
    const maxBytes = options?.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
    let cancelled = false;

    let cancelDisposable: { dispose(): void } | undefined;
    if (options?.token) {
      cancelDisposable = options.token.onCancellationRequested(() => {
        cancelled = true;
        if (proc.pid) void killProcessTree(proc.pid);
        else proc.kill('SIGTERM');
      });
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const lines = (stdoutRemainder + chunk).split('\n');
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stdout = appendRingCapture(trimmed, maxBytes, stdoutRingBytes, stdoutChunks);
        options?.onStdout?.(trimmed);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const lines = (stderrRemainder + chunk).split('\n');
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stderr = appendRingCapture(trimmed, maxBytes, stderrRingBytes, stderrChunks);
        options?.onStderr?.(trimmed);
      }
    });

    proc.on('error', (err) => {
      cancelDisposable?.dispose();
      reject(err);
    });
    proc.on('close', (code) => {
      cancelDisposable?.dispose();
      if (stdoutRemainder) {
        stdout = appendRingCapture(stdoutRemainder, maxBytes, stdoutRingBytes, stdoutChunks);
        options?.onStdout?.(stdoutRemainder);
      }
      if (stderrRemainder) {
        stderr = appendRingCapture(stderrRemainder, maxBytes, stderrRingBytes, stderrChunks);
        options?.onStderr?.(stderrRemainder);
      }
      resolve({
        exitCode: cancelled ? 130 : (code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}
