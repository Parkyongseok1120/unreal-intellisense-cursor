# Editor Bridge Protocol (v1)

UE58CursorBridge exposes authoritative Unreal Editor state to the VSIX over localhost JSON-RPC.

## Transport

- **Primary (v1):** HTTP `POST http://127.0.0.1:{port}/rpc`
- **Future:** WebSocket on the same port with identical JSON-RPC payloads

## Discovery

The editor plugin writes `.ue5_8cursor/editor-bridge.json` (gitignored — do not commit):

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

The VSIX caches the token in workspace secrets after a successful handshake. Tokens are localhost-only and valid until the editor process exits.

## Authentication

`Authorization: Bearer <token>` on every request. Localhost-only bind (`127.0.0.1`).

## JSON-RPC 2.0 Methods

| Method | Params | Result |
|--------|--------|--------|
| `handshake` | `{ client: "ue58rider", version: 1 }` | `{ ok: true, capabilities: string[] }` |
| `ping` | `{}` | `{ pong: true }` |
| `assetRegistry.list` | `{ path?: string, class?: string, limit?: number, offset?: number }` | `{ assets: AssetEntry[], total: number, hasMore: boolean }` |
| `assetRegistry.get` | `{ path: string }` | `{ asset: AssetEntry }` |
| `automation.list` | `{}` | `{ tests: AutomationTestEntry[] }` |
| `automation.run` | `{ name: string }` | `{ ok: boolean, message?: string }` |

### Planned (v1.1)

- `blueprint.getGraph`
- `pie.getState`
- `logs.subscribe`

## VSIX Client

`src/editorBridge/editorBridgeClient.ts` reads the descriptor, calls `handshake`, and exposes typed helpers.

When offline, consumers fall back to Epic MCP (provisional) or disk indexes.

## UE Plugin

`plugins/UE58CursorBridge/` — Editor module started with the Unreal Editor when the plugin is enabled in `.uproject`.

Install via command **Install Editor Bridge Plugin** (consent-gated copy into `<Project>/Plugins/`). Build with `npm run build:ue-plugin` (requires `UE_ROOT`).
