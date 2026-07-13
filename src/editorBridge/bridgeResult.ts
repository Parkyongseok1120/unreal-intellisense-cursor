export type BridgeConnectionState =
  | 'offline'
  | 'discovering'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'disconnecting'
  | 'disposed';

export type BridgeErrorKind =
  | 'offline'
  | 'timeout'
  | 'aborted'
  | 'unsupported'
  | 'protocol'
  | 'token'
  | 'malformed'
  | 'rpc'
  | 'disposed';

export class BridgeCallError extends Error {
  constructor(
    message: string,
    readonly kind: BridgeErrorKind,
  ) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

export type BridgeResult<T> =
  | { ok: true; value: T; empty?: boolean }
  | { ok: false; error: BridgeCallError };

export function bridgeSuccess<T>(value: T, empty = false): BridgeResult<T> {
  return { ok: true, value, empty };
}

export function bridgeFailure<T>(kind: BridgeErrorKind, message: string): BridgeResult<T> {
  return { ok: false, error: new BridgeCallError(message, kind) };
}

export function unwrapBridgeResult<T>(result: BridgeResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
