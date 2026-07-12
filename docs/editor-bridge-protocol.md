# Editor Bridge Protocol (v1)

UE58CursorBridge exposes authoritative Unreal Editor state to the VSIX over localhost JSON-RPC.

Schema: `schemas/editor-bridge-v1.json`  
TS registry: `src/editorBridge/bridgeProtocol.ts`

## Transport

- **Primary (v1):** HTTP `POST http://127.0.0.1:{port}/rpc`
- **Future:** WebSocket on the same port with identical JSON-RPC payloads

## Discovery

The editor plugin writes `.ue5_8cursor/editor-bridge.json` (gitignored):

```json
{
  "port": 19321,
  "pid": 12345,
  "token": "<session token>",
  "protocolVersion": 1,
  "capabilities": ["assetRegistry", "automationTests"],
  "transport": "http",
  "issuedAt": "2026-01-01T00:00:00Z",
  "tokenExpiresAt": "session"
}
```

The VSIX caches the token in workspace secrets after a successful handshake.

## Authentication

`Authorization: Bearer <token>` on every request. Localhost-only bind (`127.0.0.1`).

## Implemented methods (7.0)

| Method | Params | Result |
|--------|--------|--------|
| `handshake` | `{ client, version }` | `{ ok, capabilities }` |
| `ping` | `{}` | `{ pong }` |
| `assetRegistry.list` | `{ path?, class?, limit?, offset? }` | `{ assets, total, hasMore, offset }` |
| `assetRegistry.get` | `{ path }` | `{ asset }` |
| `blueprint.listDerived` | `{ classPath }` | `{ derived, total }` |
| `automation.list` | `{}` | `{ tests }` |
| `automation.run` | `{ name }` | `{ ok, message? }` |
| `automation.status` | `{ name }` | `{ state, message? }` |
| `automation.cancel` | `{ name }` | `{ ok }` |
| `logs.tail` | `{ lines? }` | `{ lines, count }` |
| `pie.getState` | `{}` | `{ isPlaying, mode }` |

### Planned

- `blueprint.findImplementations`, `blueprint.propertyOverrides`, `blueprint.interfaceImplementers`
- `assetRegistry.referencers`, `assetRegistry.dependencies`

## VSIX Client

`src/editorBridge/editorBridgeClient.ts` checks `isMethodImplemented()` before RPC calls.

When offline, consumers fall back to Epic MCP (provisional) or disk indexes.

## UE Plugin

`plugins/UE58CursorBridge/` — build with `npm run build:ue-plugin` (requires `UE_ROOT`).
