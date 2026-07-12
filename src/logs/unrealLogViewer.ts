import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { parseUnrealLogLine } from '../hlsl/hlslProviders';

const LOG_CHANNEL = 'UE5_8 Unreal Log';
const MAX_READ_BYTES = 1024 * 1024;

interface LogRuntimeState {
  watcher?: fs.FSWatcher;
  filePath?: string;
  offset: number;
  pollTimer?: ReturnType<typeof setInterval>;
  follow: boolean;
  categoryFilter?: string;
}

/** Project-scoped log tails sharing one OutputChannel presentation. */
export class UnrealLogViewer implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly states = new Map<string, LogRuntimeState>();
  private activeProjectRoot: string | undefined;

  constructor() { this.channel = vscode.window.createOutputChannel(LOG_CHANNEL, { log: true }); }

  private stateFor(projectRoot: string): LogRuntimeState {
    const key = projectRoot.toLowerCase();
    let state = this.states.get(key);
    if (!state) {
      state = { offset: 0, follow: true };
      this.states.set(key, state);
    }
    return state;
  }

  private activeState(): LogRuntimeState | undefined {
    return this.activeProjectRoot ? this.states.get(this.activeProjectRoot.toLowerCase()) : undefined;
  }

  async start(project: UEProject): Promise<void> {
    this.activeProjectRoot = project.projectRoot;
    const logs = await listLogFiles(project.projectRoot);
    if (logs.length === 0) {
      vscode.window.showWarningMessage('UE5_8 Cursor: no Saved/Logs log file was found for this project.');
      return;
    }
    let logFile = logs[0].path;
    if (logs.length > 1) {
      const picked = await vscode.window.showQuickPick(logs.map((l) => ({ label: l.name, description: l.path, path: l.path })), { placeHolder: 'Select Unreal log (Enter uses newest)' });
      if (picked) logFile = picked.path;
    }
    await this.tailFile(project.projectRoot, logFile);
  }

  setCategoryFilter(category?: string): void {
    const state = this.activeState();
    if (state) state.categoryFilter = category?.trim() || undefined;
  }

  setFollow(enabled: boolean): void {
    const state = this.activeState();
    if (state) state.follow = enabled;
  }

  private async tailFile(projectRoot: string, logFile: string): Promise<void> {
    const state = this.stateFor(projectRoot);
    this.stop(projectRoot);
    state.filePath = logFile;
    state.offset = 0;
    this.channel.clear();
    this.channel.show(true);
    this.channel.appendLine(`[UE5_8 Cursor] Tailing (${path.basename(projectRoot)}): ${logFile}`);
    await this.readNewContent(projectRoot);
    try {
      state.watcher = fs.watch(logFile, () => void this.readNewContent(projectRoot));
    } catch {
      state.pollTimer = setInterval(() => void this.readNewContent(projectRoot), 1500);
    }
  }

  stop(projectRoot?: string): void {
    if (!projectRoot) {
      for (const key of [...this.states.keys()]) this.stop(key);
      this.activeProjectRoot = undefined;
      return;
    }
    const state = this.states.get(projectRoot.toLowerCase());
    if (!state) return;
    state.watcher?.close();
    state.watcher = undefined;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = undefined;
    state.filePath = undefined;
    state.offset = 0;
  }

  private appendLine(projectRoot: string, line: string): void {
    if (this.activeProjectRoot?.toLowerCase() !== projectRoot.toLowerCase()) return;
    const structured = parseUnrealLogLine(line);
    const state = this.stateFor(projectRoot);
    if (state.categoryFilter && structured && structured.category !== state.categoryFilter) return;
    this.channel.appendLine(highlightLogLine(line, structured));
  }

  private async readNewContent(projectRoot: string): Promise<void> {
    const state = this.states.get(projectRoot.toLowerCase());
    if (!state?.filePath || !state.follow) return;
    try {
      const stat = await fs.promises.stat(state.filePath);
      if (stat.size < state.offset) state.offset = 0;
      if (stat.size <= state.offset) return;
      if (stat.size - state.offset > MAX_READ_BYTES) {
        state.offset = Math.max(0, stat.size - MAX_READ_BYTES);
        if (this.activeProjectRoot?.toLowerCase() === projectRoot.toLowerCase()) this.channel.appendLine('[UE5_8 Cursor] Log backlog truncated to latest 1 MiB.');
      }
      const fd = await fs.promises.open(state.filePath, 'r');
      try {
        const len = stat.size - state.offset;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, state.offset);
        state.offset = stat.size;
        for (const line of buf.toString('utf-8').split(/\r?\n/)) if (line.length) this.appendLine(projectRoot, line);
      } finally { await fd.close(); }
    } catch { /* log rotated or deleted */ }
  }

  dispose(): void { this.stop(); this.states.clear(); this.channel.dispose(); }
}

function highlightLogLine(line: string, structured?: ReturnType<typeof parseUnrealLogLine>): string {
  if (structured) {
    const prefix = `[${structured.category}]`;
    if (structured.verbosity === 'Error' || structured.verbosity === 'Fatal') return `ERROR ${prefix} ${structured.message}`;
    if (structured.verbosity === 'Warning') return `WARN ${prefix} ${structured.message}`;
    return `${prefix} ${structured.message}`;
  }
  if (/\bError\b/i.test(line)) return `ERROR ${line}`;
  if (/\bWarning\b/i.test(line)) return `WARN ${line}`;
  return line;
}

async function listLogFiles(projectRoot: string): Promise<Array<{ name: string; path: string; mtime: number }>> {
  const logsDir = path.join(projectRoot, 'Saved', 'Logs');
  try {
    const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });
    const files: Array<{ name: string; path: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const full = path.join(logsDir, entry.name);
      const stat = await fs.promises.stat(full);
      files.push({ name: entry.name, path: full, mtime: stat.mtimeMs });
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
