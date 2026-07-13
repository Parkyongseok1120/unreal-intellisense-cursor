import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { UEProject } from '../types';
import { ensureDataDir } from '../platform/dataDir';
import { mutateBytes, runWithTransaction, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import { ensurePluginInUProject } from '../parsers/uprojectParser';
import { getExtensionVersion } from '../version';

const BRIDGE_FILE = 'editor-bridge.json';
const BASE_PORT = 19321;
const PORT_RANGE = 20;
const DEFAULT_RPC_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_RPC_REQUEST_BYTES = 1024 * 1024;

let rpcIdSeq = 0;
export function nextBridgeRpcId(): string {
  return `rpc-${Date.now()}-${++rpcIdSeq}`;
}

export interface EditorBridgeDescriptor {
  port: number;
  pid: number;
  token: string;
  protocolVersion: number;
  capabilityVersion?: number;
  capabilities: string[];
  transport: 'http' | 'websocket';
  projectId?: string;
  engineBuildId?: string;
  processStartTime?: number;
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
      const parsed = JSON.parse(raw) as EditorBridgeDescriptor;
      if (!validateDescriptor(parsed, projectRoot)) return undefined;
      return parsed;
    } catch {
      // try next
    }
  }
  return undefined;
}

function validateDescriptor(descriptor: EditorBridgeDescriptor, projectRoot: string): boolean {
  if (!descriptor.port || !descriptor.token || !descriptor.pid) return false;
  if (descriptor.protocolVersion !== 1) return false;
  const projectId = path.basename(projectRoot);
  if (descriptor.projectId && descriptor.projectId !== projectId) return false;
  return true;
}

export async function writeEditorBridgeDescriptor(
  projectRoot: string,
  info: EditorBridgeDescriptor,
): Promise<void> {
  const dir = await ensureDataDir(projectRoot);
  const finalPath = path.join(dir, BRIDGE_FILE);
  const tempPath = `${finalPath}.tmp`;
  const payload = JSON.stringify(info, null, 2) + '\n';
  await fs.promises.writeFile(tempPath, payload, 'utf-8');
  await fs.promises.rename(tempPath, finalPath);
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
  const requestId = nextBridgeRpcId();
  const body: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, params };
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_RPC_REQUEST_BYTES) {
    throw new Error('Editor bridge RPC request exceeded size limit');
  }

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
            if (json.id !== undefined && String(json.id) !== requestId) {
              finish(() => reject(new Error('Editor bridge RPC response ID mismatch')));
              return;
            }
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

export function isBridgePluginBinaryPresent(projectRoot: string, platform = 'Win64'): boolean {
  return bridgePluginBinaryPresentAt(path.join(projectRoot, 'Plugins', 'UE58CursorBridge'), platform);
}

function bridgePluginBinaryPresentAt(pluginRoot: string, platform = 'Win64'): boolean {
  const binariesDir = path.join(pluginRoot, 'Binaries', platform);
  try {
    const entries = fs.readdirSync(binariesDir);
    return entries.some((name) => name.toLowerCase().endsWith('.dll') || name.toLowerCase().endsWith('.dylib'));
  } catch {
    return false;
  }
}

export function resolveBridgePluginSource(extensionPath: string): { path: string; prebuilt: boolean } | undefined {
  const candidates = [
    path.join(extensionPath, 'Saved', 'UE58CursorBridge'),
    path.join(extensionPath, 'plugins', 'UE58CursorBridge'),
  ];
  for (const candidate of candidates) {
    const uplugin = path.join(candidate, 'UE58CursorBridge.uplugin');
    if (!fs.existsSync(uplugin)) continue;
    const prebuilt = bridgePluginBinaryPresentAt(candidate);
    return { path: candidate, prebuilt };
  }
  return undefined;
}

export async function listCursorBridgePluginFiles(extensionPath: string): Promise<string[]> {
  const resolved = resolveBridgePluginSource(extensionPath);
  const src = resolved?.path ?? path.join(extensionPath, 'plugins', 'UE58CursorBridge');
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
  allowUpgrade?: boolean;
  bridgeContext?: vscode.ExtensionContext;
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function buildPluginManifest(root: string): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  async function walk(dir: string, prefix = ''): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        manifest.set(rel.replace(/\\/g, '/'), await sha256File(full));
      }
    }
  }
  await walk(root);
  return manifest;
}

function validateUpluginFields(obj: unknown): void {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid .uplugin JSON');
  const record = obj as Record<string, unknown>;
  if (typeof record.FileVersion !== 'number') throw new Error('.uplugin missing FileVersion');
  if (!Array.isArray(record.Modules) || record.Modules.length === 0) throw new Error('.uplugin missing Modules');
  if (typeof record.FriendlyName !== 'string') throw new Error('.uplugin missing FriendlyName');
}

async function verifyPluginManifestMatch(src: string, staged: string): Promise<void> {
  const [srcManifest, stagedManifest] = await Promise.all([buildPluginManifest(src), buildPluginManifest(staged)]);
  for (const [rel, hash] of srcManifest) {
    if (stagedManifest.get(rel) !== hash) {
      throw new Error(`Plugin manifest hash mismatch: ${rel}`);
    }
  }
}

async function verifyBridgeHandshake(
  projectRoot: string,
  descriptor: EditorBridgeDescriptor,
  bridgeContext?: vscode.ExtensionContext,
): Promise<boolean> {
  try {
    const token = await resolveBridgeToken(bridgeContext, descriptor, projectRoot);
    const result = (await editorBridgeRpc(
      { ...descriptor, token },
      'handshake',
      { client: 'ue58rider', version: 1 },
      { timeoutMs: 5000 },
    )) as { ok?: boolean };
    return !!result?.ok;
  } catch {
    return false;
  }
}

export async function installCursorBridgePlugin(
  project: UEProject,
  options: InstallCursorBridgeOptions,
): Promise<{
  ok: boolean;
  message?: string;
  copied?: boolean;
  upgraded?: boolean;
  uprojectUpdated?: boolean;
  needsBuild?: boolean;
}> {
  if (!options.consentGranted) {
    return { ok: false, message: 'User consent required' };
  }

  const resolved = resolveBridgePluginSource(options.extensionPath);
  if (!resolved) {
    return { ok: false, message: 'Bundled UE58CursorBridge plugin not found in extension' };
  }

  const src = resolved.path;
  const dest = path.join(project.projectRoot, 'Plugins', 'UE58CursorBridge');
  const destExists = await dirExists(dest);
  const destHasBinary = isBridgePluginBinaryPresent(project.projectRoot);

  if (destExists && destHasBinary && !options.allowUpgrade) {
    return { ok: true, message: 'Plugin already installed', copied: false };
  }

  if (destExists && !options.allowUpgrade) {
    return {
      ok: true,
      message: 'Plugin folder exists but binaries missing — enable allowUpgrade to refresh',
      copied: false,
      needsBuild: !resolved.prebuilt,
    };
  }

  const { isUnrealEditorRunning } = await import('../platform/process');
  if (options.allowUpgrade && destExists && (await isUnrealEditorRunning())) {
    return {
      ok: false,
      message: 'Close the Unreal Editor before upgrading UE58CursorBridge (plugin DLL may be locked).',
    };
  }

  const sessionId = crypto.randomBytes(4).toString('hex');
  const staging = path.join(project.projectRoot, '.ue5_8cursor', 'staging', `UE58CursorBridge-${sessionId}`);
  let copied = false;
  let upgraded = false;
  let uprojectUpdated = false;

  try {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.cp(src, staging, { recursive: true });

    const stagedUplugin = path.join(staging, 'UE58CursorBridge.uplugin');
    if (!(await fileExists(stagedUplugin))) {
      throw new Error('Staged plugin is missing UE58CursorBridge.uplugin');
    }
    validateUpluginFields(JSON.parse(await fs.promises.readFile(stagedUplugin, 'utf-8')));
    await verifyPluginManifestMatch(src, staging);

    await runWithTransaction(project.projectRoot, async (tx) => {
      await copyTreeInTransaction(tx, project.projectRoot, staging, dest, { consentGranted: true });
      copied = true;
      if (destExists) upgraded = true;
      if (options.enableInUproject !== false) {
        uprojectUpdated = await ensurePluginInUProject(project.uprojectPath, 'UE58CursorBridge', tx, {
          consentGranted: true,
        });
      }
    });

    const editorRunning = await isUnrealEditorRunning();
    if (editorRunning) {
      const descriptor = await readEditorBridgeDescriptor(project.projectRoot);
      if (descriptor) {
        const handshakeOk = await verifyBridgeHandshake(project.projectRoot, descriptor, options.bridgeContext);
        if (!handshakeOk) {
          throw new Error('Bridge handshake failed after plugin install');
        }
      }
    }
  } catch (err) {
    return { ok: false, message: `Plugin install failed: ${err}` };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  const needsBuild = !isBridgePluginBinaryPresent(project.projectRoot);
  return {
    ok: true,
    message: needsBuild
      ? 'UE58CursorBridge installed (source only). Build the plugin with npm run build:ue-plugin, then restart the editor.'
      : 'UE58CursorBridge installed. Restart the Unreal Editor to load the bridge.',
    copied,
    upgraded,
    uprojectUpdated,
    needsBuild,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
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
  opts?: { consentGranted?: boolean },
): Promise<void> {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeInTransaction(tx, projectRoot, from, to, opts);
    } else {
      const content = await fs.promises.readFile(from);
      await mutateBytes(tx, projectRoot, to, content, opts);
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
