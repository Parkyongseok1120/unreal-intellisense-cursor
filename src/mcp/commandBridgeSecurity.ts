export const BRIDGE_MAX_BODY_BYTES = 4096;
export const BRIDGE_REQUEST_MAX_AGE_MS = 60_000;

/** Commands the MCP bridge may invoke — all others are rejected. */
export const COMMAND_BRIDGE_ALLOWLIST = new Set([
  'ue58rider.build',
  'ue58rider.rebuild',
  'ue58rider.clean',
  'ue58rider.liveCoding',
  'ue58rider.generateCompileCommands',
  'ue58rider.refreshMcpSchema',
  'ue58rider.refreshUhtIntellisense',
  'ue58rider.refreshAssetIndex',
]);

export interface CommandBridgeRequest {
  command: string;
  args?: unknown[];
  nonce?: string;
  issuedAt?: number;
}

export type CommandBridgeValidationResult =
  | { ok: true; request: CommandBridgeRequest }
  | { ok: false; status: number; error: string };

export function validateCommandBridgeRequest(
  body: string,
  options?: { now?: number; maxAgeMs?: number },
): CommandBridgeValidationResult {
  if (body.length > BRIDGE_MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Request body too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'Request must be a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, status: 400, error: 'command must be a non-empty string' };
  }

  if (!COMMAND_BRIDGE_ALLOWLIST.has(command)) {
    return { ok: false, status: 403, error: `Command not allowed: ${command}` };
  }

  const args = record.args;
  if (args !== undefined && !Array.isArray(args)) {
    return { ok: false, status: 400, error: 'args must be an array when provided' };
  }

  const issuedAt = record.issuedAt;
  if (issuedAt !== undefined) {
    if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
      return { ok: false, status: 400, error: 'issuedAt must be a finite number' };
    }
    const now = options?.now ?? Date.now();
    const maxAge = options?.maxAgeMs ?? BRIDGE_REQUEST_MAX_AGE_MS;
    if (Math.abs(now - issuedAt) > maxAge) {
      return { ok: false, status: 401, error: 'Request expired' };
    }
  }

  const nonce = record.nonce;
  if (nonce !== undefined && (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128)) {
    return { ok: false, status: 400, error: 'nonce must be a non-empty string up to 128 chars' };
  }

  return {
    ok: true,
    request: {
      command,
      args: args as unknown[] | undefined,
      nonce: typeof nonce === 'string' ? nonce : undefined,
      issuedAt: typeof issuedAt === 'number' ? issuedAt : undefined,
    },
  };
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
