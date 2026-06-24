import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDataDir } from '../platform/dataDir';

const BRIDGE_FILE = 'command-bridge.json';
const BASE_PORT = 19221;
const PORT_RANGE = 20;

export interface CommandBridgeInfo {
  port: number;
  pid: number;
}

export class CommandBridge implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<number> {
    if (this.server) return this.port;

    for (let i = 0; i < PORT_RANGE; i++) {
      const port = BASE_PORT + i;
      try {
        await this.listen(port);
        this.port = port;
        await this.writeBridgeFile();
        return port;
      } catch {
        // try next
      }
    }
    throw new Error('UE5_8 Cursor: command bridge port unavailable');
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/command') {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          try {
            const { command, args } = JSON.parse(body) as { command: string; args?: unknown[] };
            await vscode.commands.executeCommand(command, ...(args ?? []));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async writeBridgeFile(): Promise<void> {
    const dir = await ensureDataDir(this.projectRoot);
    const info: CommandBridgeInfo = { port: this.port, pid: process.pid };
    await fs.promises.writeFile(path.join(dir, BRIDGE_FILE), JSON.stringify(info, null, 2) + '\n', 'utf-8');
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}

export async function readBridgePort(projectRoot: string): Promise<number | undefined> {
  try {
    const { resolveDataDir } = await import('../platform/dataDir');
    const raw = await fs.promises.readFile(path.join(resolveDataDir(projectRoot), BRIDGE_FILE), 'utf-8');
    const info = JSON.parse(raw) as CommandBridgeInfo;
    return info.port;
  } catch {
    return undefined;
  }
}
