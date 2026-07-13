import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDataDir } from '../platform/dataDir';
import {
  BRIDGE_MAX_BODY_BYTES,
  extractBearerToken,
  timingSafeEqualStrings,
  validateCommandBridgeRequest,
} from './commandBridgeSecurity';

const BRIDGE_FILE = 'command-bridge.json';
const BASE_PORT = 19221;
const PORT_RANGE = 20;

export interface CommandBridgeInfo {
  port: number;
  pid: number;
  token: string;
}

export class CommandBridge implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  private readonly token: string;
  private startPromise: Promise<number> | undefined;
  private disposed = false;

  constructor(private readonly projectRoot: string) {
    this.token = crypto.randomBytes(32).toString('hex');
  }

  getAuthToken(): string {
    return this.token;
  }

  async start(): Promise<number> {
    if (this.disposed) {
      throw new Error('UE5_8 Cursor: command bridge disposed');
    }
    if (this.server) return this.port;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<number> {
    for (let i = 0; i < PORT_RANGE; i++) {
      if (this.disposed) {
        throw new Error('UE5_8 Cursor: command bridge disposed during start');
      }
      const port = BASE_PORT + i;
      const server = await this.tryListen(port);
      if (this.disposed) {
        if (server) await this.closeServer(server);
        throw new Error('UE5_8 Cursor: command bridge disposed during start');
      }
      if (!server) continue;
      try {
        await this.writeBridgeFile(port);
        if (this.disposed) {
          await this.closeServer(server);
          throw new Error('UE5_8 Cursor: command bridge disposed during start');
        }
        this.server = server;
        this.port = port;
        return port;
      } catch (err) {
        await this.closeServer(server);
        throw err;
      }
    }
    throw new Error('UE5_8 Cursor: command bridge port unavailable');
  }

  private tryListen(port: number): Promise<http.Server | undefined> {
    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        res.on('error', () => {});
        if (req.method !== 'POST' || req.url !== '/command') {
          res.writeHead(404);
          res.end();
          return;
        }

        const auth = extractBearerToken(req.headers.authorization);
        if (!auth || !timingSafeEqualStrings(auth, this.token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }

        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        let tooLarge = false;

        req.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
          if (bodyBytes > BRIDGE_MAX_BODY_BYTES) {
            tooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        req.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request error' }));
          }
        });

        req.on('end', async () => {
          if (tooLarge || res.writableEnded || this.disposed) return;

          const body = Buffer.concat(chunks).toString('utf-8');
          const validation = validateCommandBridgeRequest(body);
          if (!validation.ok) {
            res.writeHead(validation.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: validation.error }));
            return;
          }

          try {
            const { command, args } = validation.request;
            await vscode.commands.executeCommand('ue58rider.executeProjectBridgeCommand', {
              projectRoot: this.projectRoot,
              command,
              args: args ?? [],
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });

      server.once('error', () => resolve(undefined));
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
  }

  private closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async writeBridgeFile(port: number): Promise<void> {
    const dir = await ensureDataDir(this.projectRoot);
    const info: CommandBridgeInfo = { port, pid: process.pid, token: this.token };
    const filePath = path.join(dir, BRIDGE_FILE);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(info, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
  }

  private async removeBridgeFile(): Promise<void> {
    try {
      const { resolveDataDir } = await import('../platform/dataDir');
      await fs.promises.unlink(path.join(resolveDataDir(this.projectRoot), BRIDGE_FILE));
    } catch {
      // file may not exist
    }
  }

  dispose(): void {
    this.disposed = true;
    this.startPromise = undefined;
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    server?.close();
    void this.removeBridgeFile();
  }
}

export async function readBridgeInfo(projectRoot: string): Promise<CommandBridgeInfo | undefined> {
  try {
    const { resolveDataDir } = await import('../platform/dataDir');
    const raw = await fs.promises.readFile(path.join(resolveDataDir(projectRoot), BRIDGE_FILE), 'utf-8');
    const info = JSON.parse(raw) as CommandBridgeInfo;
    if (!info.port || !info.token) return undefined;
    return info;
  } catch {
    return undefined;
  }
}

export async function readBridgePort(projectRoot: string): Promise<number | undefined> {
  const info = await readBridgeInfo(projectRoot);
  return info?.port;
}
