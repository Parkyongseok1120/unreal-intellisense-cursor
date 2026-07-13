import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { parseUnrealLogLine } from '../hlsl/hlslProviders';

const LOG_CHANNEL = 'UE5_8 Unreal Log';
const MAX_READ_BYTES = 1024 * 1024;

export interface LogViewerBridge {
  isConnected(): boolean;
  canCall(method: string): boolean;
  tailLogsResult?(lines?: number, offset?: number, fileId?: string): Promise<import('../editorBridge/bridgeResult').BridgeResult<string[]>>;
  tailLogs(lines?: number, offset?: number, fileId?: string): Promise<string[]>;
}

interface LogRuntimeState {
  watcher?: fs.FSWatcher;
  filePath?: string;
  fileId?: string;
  offset: number;
  partialLine: string;
  partialBytes: Buffer;
  pollTimer?: ReturnType<typeof setInterval>;
  bridgeTimer?: ReturnType<typeof setInterval>;
  bridge?: LogViewerBridge;
  bridgeSeen?: Set<string>;
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
      state = { offset: 0, follow: true, partialLine: '', partialBytes: Buffer.alloc(0) };
      this.states.set(key, state);
    }
    if (!state.partialBytes) state.partialBytes = Buffer.alloc(0);
    return state;
  }

  private activeState(): LogRuntimeState | undefined {
    return this.activeProjectRoot ? this.states.get(this.activeProjectRoot.toLowerCase()) : undefined;
  }

  async start(project: UEProject, bridge?: LogViewerBridge): Promise<void> {
    this.activeProjectRoot = project.projectRoot;
    const logs = await listLogFiles(project.projectRoot);
    if (logs.length === 0) {
      if (bridge?.isConnected() && bridge.canCall('logs.tail')) {
        await this.startBridgeTail(project.projectRoot, bridge);
        return;
      }
      vscode.window.showWarningMessage('UE5_8 Cursor: no Saved/Logs log file was found for this project.');
      return;
    }
    let logFile = logs[0].path;
    if (logs.length > 1) {
      const picked = await vscode.window.showQuickPick(logs.map((l) => ({ label: l.name, description: l.path, path: l.path })), { placeHolder: 'Select Unreal log (Enter uses newest)' });
      if (picked) logFile = picked.path;
    }
    await this.tailFile(project.projectRoot, logFile, bridge);
  }

  setCategoryFilter(category?: string): void {
    const state = this.activeState();
    if (state) state.categoryFilter = category?.trim() || undefined;
  }

  setFollow(enabled: boolean): void {
    const state = this.activeState();
    if (state) state.follow = enabled;
  }

  private async startBridgeTail(projectRoot: string, bridge: LogViewerBridge): Promise<void> {
    const state = this.stateFor(projectRoot);
    this.stop(projectRoot);
    state.bridge = bridge;
    state.bridgeSeen = new Set();
    this.channel.clear();
    this.channel.show(true);
    this.channel.appendLine(`[UE5_8 Cursor] Tailing editor bridge logs (${path.basename(projectRoot)})`);
    await this.pollBridgeTail(projectRoot);
    state.bridgeTimer = setInterval(() => void this.pollBridgeTail(projectRoot), 2000);
  }

  private async pollBridgeTail(projectRoot: string): Promise<void> {
    const state = this.states.get(projectRoot.toLowerCase());
    if (!state?.bridge || !state.follow) return;
    if (!state.bridge.isConnected() || !state.bridge.canCall('logs.tail')) return;
    try {
      const client = state.bridge as import('../editorBridge/editorBridgeClient').EditorBridgeClient;
      const result = typeof client.tailLogsResult === 'function'
        ? await client.tailLogsResult(200, state.offset, state.fileId)
        : undefined;
      const lines = result
        ? (result.ok ? result.value : [])
        : await state.bridge.tailLogs(200, state.offset, state.fileId);
      for (const line of lines) {
        const key = line.trim();
        if (!key || state.bridgeSeen?.has(key)) continue;
        state.bridgeSeen?.add(key);
        this.appendLine(projectRoot, line);
      }
    } catch {
      // bridge log tail optional
    }
  }

  private async tailFile(projectRoot: string, logFile: string, bridge?: LogViewerBridge): Promise<void> {
    const state = this.stateFor(projectRoot);
    this.stop(projectRoot);
    state.filePath = logFile;
    state.fileId = logFile.toLowerCase();
    state.offset = 0;
    state.partialLine = '';
    state.partialBytes = Buffer.alloc(0);
    state.bridge = bridge;
    state.bridgeSeen = new Set();
    this.channel.clear();
    this.channel.show(true);
    this.channel.appendLine(`[UE5_8 Cursor] Tailing (${path.basename(projectRoot)}): ${logFile}`);
    await this.readNewContent(projectRoot);
    try {
      state.watcher = fs.watch(logFile, () => void this.readNewContent(projectRoot));
    } catch {
      state.pollTimer = setInterval(() => void this.readNewContent(projectRoot), 1500);
    }
    if (bridge?.isConnected() && bridge.canCall('logs.tail')) {
      state.bridgeTimer = setInterval(() => void this.pollBridgeTail(projectRoot), 5000);
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
    if (state.bridgeTimer) clearInterval(state.bridgeTimer);
    state.bridgeTimer = undefined;
    state.filePath = undefined;
    state.fileId = undefined;
    state.offset = 0;
    state.partialLine = '';
    state.partialBytes = Buffer.alloc(0);
    state.bridge = undefined;
    state.bridgeSeen = undefined;
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
      const fileId = state.filePath.toLowerCase();
      if (state.fileId && state.fileId !== fileId) {
        state.offset = 0;
        state.partialLine = '';
      }
      state.fileId = fileId;
      if (stat.size < state.offset) {
        state.offset = 0;
        state.partialLine = '';
        if (this.activeProjectRoot?.toLowerCase() === projectRoot.toLowerCase()) {
          this.channel.appendLine('[UE5_8 Cursor] Log rotated — tailing from start.');
        }
      }
      if (stat.size <= state.offset) return;
      if (stat.size - state.offset > MAX_READ_BYTES) {
        state.offset = Math.max(0, stat.size - MAX_READ_BYTES);
        state.partialLine = '';
        if (this.activeProjectRoot?.toLowerCase() === projectRoot.toLowerCase()) {
          this.channel.appendLine('[UE5_8 Cursor] Log backlog truncated to latest 1 MiB.');
        }
      }
      const fd = await fs.promises.open(state.filePath, 'r');
      try {
        const len = stat.size - state.offset;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, state.offset);
        state.offset = stat.size;
        const combined = Buffer.concat([state.partialBytes, buf]);
        let end = combined.length;
        while (end > 0 && (combined[end - 1] & 0xC0) === 0x80) end--;
        state.partialBytes = combined.subarray(end);
        const chunk = state.partialLine + combined.subarray(0, end).toString('utf-8');
        const parts = chunk.split(/\r?\n/);
        state.partialLine = chunk.endsWith('\n') || chunk.endsWith('\r') ? '' : parts.pop() ?? '';
        for (const line of parts) {
          if (line.length) this.appendLine(projectRoot, line);
        }
      } finally { await fd.close(); }
    } catch { /* log rotated or deleted */ }
  }

  dispose(): void { this.stop(); this.states.clear(); this.channel.dispose(); }
}

function highlightLogLine(line: string, structured?: ReturnType<typeof parseUnrealLogLine>): string {
  const sourceLink = line.match(/([A-Za-z]:\\[^\s:]+\.(?:cpp|h|usf|ush)):(\d+)/i);
  if (sourceLink) {
    const linked = `${sourceLink[1]}:${sourceLink[2]}`;
    return structured
      ? `[${structured.category}] ${structured.message} (${linked})`
      : `${line} (${linked})`;
  }
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
