import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { UEProject } from '../types';
import { ensureDataDir } from '../platform/dataDir';
import { mutateText, runWithTransaction, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { ensurePluginInUProject } from '../parsers/uprojectParser';
import { getExtensionVersion } from '../version';

const BRIDGE_FILE = 'editor-bridge.json';
const BASE_PORT = 19321;
const PORT_RANGE = 20;
const DEFAULT_RPC_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface EditorBridgeDescriptor {
  port: number;
  pid: number;
  token: string;
  protocolVersion: number;
  capabilities: string[];
  transport: 'http' | 'websocket';
  issuedAt?: string;
  tokenExpiresAt?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface EditorBridgeRpcOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

function bridgeTokenKey(projectRoot: string, pid: number): string {
  return `bridge-token:${path.resolve(projectRoot)}:${pid}`;
}

export async function cacheBridgeToken(
  context: vscode.ExtensionContext | undefined,
  descriptor: EditorBridgeDescriptor,
  projectRoot: string,
): Promise<void> {
  if (!context?.secrets) return;
  await context.secrets.store(bridgeTokenKey(projectRoot, descriptor.pid), descriptor.token);
}

export async function resolveBridgeToken(
  context: vscode.ExtensionContext | undefined,
  descriptor: EditorBridgeDescriptor,
  projectRoot: string,
): Promise<string> {
  if (context?.secrets) {
    const cached = await context.secrets.get(bridgeTokenKey(projectRoot, descriptor.pid));
    if (cached) return cached;
  }
  return descriptor.token;
}

export async function readEditorBridgeDescriptor(projectRoot: string): Promise<EditorBridgeDescriptor | undefined> {
  for (const sub of ['.ue5_8cursor', '.ue58rider']) {
    try {
      const raw = await fs.promises.readFile(path.join(projectRoot, sub, BRIDGE_FILE), 'utf-8');
      return JSON.parse(raw) as EditorBridgeDescriptor;
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function writeEditorBridgeDescriptor(
  projectRoot: string,
  info: EditorBridgeDescriptor,
): Promise<void> {
  const dir = await ensureDataDir(projectRoot);
  await fs.promises.writeFile(path.join(dir, BRIDGE_FILE), JSON.stringify(info, null, 2) + '\n', 'utf-8');
}

export function editorBridgePortRange(): { base: number; range: number } {
  return { base: BASE_PORT, range: PORT_RANGE };
}

export async function editorBridgeRpc(
  descriptor: EditorBridgeDescriptor,
  method: string,
  params?: unknown,
  options: EditorBridgeRpcOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const body: JsonRpcRequest = { jsonrpc: '2.0', id: Date.now(), method, params };
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: descriptor.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${descriptor.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxResponseBytes) {
            req.destroy(new Error('Editor bridge response exceeded size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            finish(() => reject(new Error(`Editor bridge RPC failed: HTTP ${res.statusCode}`)));
            return;
          }
          try {
            const json = JSON.parse(data) as JsonRpcResponse;
            if (json.error) {
              finish(() => reject(new Error(json.error!.message)));
              return;
            }
            finish(() => resolve(json.result));
          } catch (err) {
            finish(() => reject(err));
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Editor bridge RPC timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => finish(() => reject(err)));

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error('Editor bridge RPC aborted'));
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => {
          req.destroy(new Error('Editor bridge RPC aborted'));
        },
        { once: true },
      );
    }

    req.write(payload);
    req.end();
  });
}

export function isCursorBridgePluginInstalled(project: UEProject): boolean {
  return fs.existsSync(path.join(project.projectRoot, 'Plugins', 'UE58CursorBridge', 'UE58CursorBridge.uplugin'));
}

export async function listCursorBridgePluginFiles(extensionPath: string): Promise<string[]> {
  const src = path.join(extensionPath, 'plugins', 'UE58CursorBridge');
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push(path.relative(src, full).replace(/\\/g, '/'));
      }
    }
  }

  if (await dirExists(src)) {
    await walk(src);
  }
  return files.sort();
}

export interface InstallCursorBridgeOptions {
  consentGranted: boolean;
  enableInUproject?: boolean;
  extensionPath: string;
}

export async function installCursorBridgePlugin(
  project: UEProject,
  options: InstallCursorBridgeOptions,
): Promise<{ ok: boolean; message?: string; copied?: boolean; uprojectUpdated?: boolean }> {
  if (!options.consentGranted) {
    return { ok: false, message: 'User consent required' };
  }

  const src = path.join(options.extensionPath, 'plugins', 'UE58CursorBridge');
  const dest = path.join(project.projectRoot, 'Plugins', 'UE58CursorBridge');
  if (!(await dirExists(src))) {
    return { ok: false, message: 'Bundled UE58CursorBridge plugin not found in extension' };
  }
  if (await dirExists(dest)) {
    return { ok: true, message: 'Plugin already installed', copied: false };
  }

  let copied = false;
  let uprojectUpdated = false;

  await runWithTransaction(project.projectRoot, async (tx) => {
    await copyTreeInTransaction(tx, project.projectRoot, src, dest);
    copied = true;
    if (options.enableInUproject !== false) {
      uprojectUpdated = await ensurePluginInUProject(project.uprojectPath, 'UE58CursorBridge', tx, {
        consentGranted: true,
      });
    }
  });

  return {
    ok: true,
    message: 'UE58CursorBridge installed',
    copied,
    uprojectUpdated,
  };
}

/** @deprecated Use installCursorBridgePlugin with explicit consent. */
export async function ensureCursorBridgePlugin(
  project: UEProject,
  extensionPath: string,
): Promise<boolean> {
  if (isCursorBridgePluginInstalled(project)) return false;
  return false;
}

async function copyTreeInTransaction(
  tx: WorkspaceMutationTransaction,
  projectRoot: string,
  src: string,
  dest: string,
): Promise<void> {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeInTransaction(tx, projectRoot, from, to);
    } else {
      const content = await fs.promises.readFile(from, 'utf-8');
      await mutateText(tx, projectRoot, to, content);
    }
  }
}

export function formatInstallPreview(
  project: UEProject,
  extensionPath: string,
  files: string[],
): string {
  const version = getExtensionVersion(extensionPath);
  const dest = path.join(project.projectRoot, 'Plugins', 'UE58CursorBridge');
  const preview = files.slice(0, 12).map((f) => `  - ${f}`).join('\n');
  const more = files.length > 12 ? `\n  ... and ${files.length - 12} more` : '';
  return [
    `UE58CursorBridge v${version}`,
    `Target: ${dest}`,
    `Files (${files.length}):`,
    preview + more,
    '',
    'Also enables the plugin in .uproject when you confirm.',
  ].join('\n');
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.promises.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
