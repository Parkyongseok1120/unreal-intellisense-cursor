import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import { parseUnrealLogLine } from '../hlsl/hlslProviders';

const LOG_CHANNEL = 'UE5_8 Unreal Log';

export class UnrealLogViewer implements vscode.Disposable {
  private channel: vscode.OutputChannel;
  private watcher: fs.FSWatcher | undefined;
  private filePath: string | undefined;
  private offset = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private follow = true;
  private categoryFilter: string | undefined;

  constructor() {
    this.channel = vscode.window.createOutputChannel(LOG_CHANNEL, { log: true });
  }

  async start(project: UEProject): Promise<void> {
    this.stop();
    const logs = await listLogFiles(project.projectRoot);
    if (logs.length === 0) {
      vscode.window.showWarningMessage('UE5_8 Cursor: Saved/Logs에서 로그 파일을 찾지 못했습니다.');
      return;
    }

    let logFile = logs[0].path;
    if (logs.length > 1) {
      const picked = await vscode.window.showQuickPick(
        logs.map((l) => ({ label: l.name, description: l.path, path: l.path })),
        { placeHolder: '로그 파일 선택 (Enter=최신)' },
      );
      if (picked) logFile = picked.path;
    }

    await this.tailFile(logFile);
  }

  setCategoryFilter(category?: string): void {
    this.categoryFilter = category?.trim() || undefined;
  }

  setFollow(enabled: boolean): void {
    this.follow = enabled;
  }

  private async tailFile(logFile: string): Promise<void> {
    this.filePath = logFile;
    this.offset = 0;
    this.channel.clear();
    this.channel.show(true);
    this.channel.appendLine(`[UE5_8 Cursor] Tailing: ${logFile}`);

    await this.readNewContent();

    try {
      this.watcher = fs.watch(logFile, () => void this.readNewContent());
    } catch {
      this.pollTimer = setInterval(() => void this.readNewContent(), 1500);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.filePath = undefined;
    this.offset = 0;
  }

  private async readNewContent(): Promise<void> {
    if (!this.filePath || !this.follow) return;
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size < this.offset) this.offset = 0;
      if (stat.size <= this.offset) return;

      const fd = await fs.promises.open(this.filePath, 'r');
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, this.offset);
        this.offset = stat.size;
        const text = buf.toString('utf-8');
        for (const line of text.split(/\r?\n/)) {
          if (line.length === 0) continue;
          const structured = parseUnrealLogLine(line);
          if (this.categoryFilter && structured && structured.category !== this.categoryFilter) {
            continue;
          }
          this.channel.appendLine(highlightLogLine(line, structured));
        }
      } finally {
        await fd.close();
      }
    } catch {
      // log rotated or deleted
    }
  }

  dispose(): void {
    this.stop();
    this.channel.dispose();
  }
}

function highlightLogLine(line: string, structured?: ReturnType<typeof parseUnrealLogLine>): string {
  if (structured) {
    const prefix = `[${structured.category}]`;
    if (structured.verbosity === 'Error' || structured.verbosity === 'Fatal') return `❌ ${prefix} ${structured.message}`;
    if (structured.verbosity === 'Warning') return `⚠️ ${prefix} ${structured.message}`;
    return `${prefix} ${structured.message}`;
  }
  if (/\bError\b/i.test(line)) return `❌ ${line}`;
  if (/\bWarning\b/i.test(line)) return `⚠️ ${line}`;
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
  } catch {
    return [];
  }
}
