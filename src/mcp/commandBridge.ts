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

  constructor(private readonly projectRoot: string) {
    this.token = crypto.randomBytes(32).toString('hex');
  }

  getAuthToken(): string {
    return this.token;
  }

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

        const auth = extractBearerToken(req.headers.authorization);
        if (!auth || !timingSafeEqualStrings(auth, this.token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }

        let body = '';
        let tooLarge = false;
        req.on('data', (chunk: Buffer | string) => {
          body += chunk;
          if (body.length > BRIDGE_MAX_BODY_BYTES) {
            tooLarge = true;
            req.destroy();
          }
        });

        req.on('end', async () => {
          if (tooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
            return;
          }

          const validation = validateCommandBridgeRequest(body);
          if (!validation.ok) {
            res.writeHead(validation.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: validation.error }));
            return;
          }

          try {
            const { command, args } = validation.request;
            // Keep the authenticated endpoint's owning .uproject attached to
            // the command. Generic VS Code commands otherwise resolve from the
            // currently focused editor and can target a different workspace.
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
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async writeBridgeFile(): Promise<void> {
    const dir = await ensureDataDir(this.projectRoot);
    const info: CommandBridgeInfo = { port: this.port, pid: process.pid, token: this.token };
    const filePath = path.join(dir, BRIDGE_FILE);
    await fs.promises.writeFile(filePath, JSON.stringify(info, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
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
    this.server?.close();
    this.server = undefined;
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
