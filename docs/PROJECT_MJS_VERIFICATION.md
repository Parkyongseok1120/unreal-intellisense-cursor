# Project_MJS v5.4 Verification Guide

## Automated (no editor)

```bash
cd ue5-8-cursor
npm test                    # includes project-mjs-integration.test.mjs
npm run verify:project-mjs  # patches + index + MCP capture if editor online
```

## Prerequisites applied

- `Project_MJS.uproject` — `ModelContextProtocol`, `AllToolsets` enabled
- `.cursor/mcp.json` — `http://127.0.0.1:8000/mcp`
- `.ue5_8cursor/` — asset index + verification report

## Manual checklist (requires UE Editor)

1. Launch Unreal Editor (port 8000 MCP auto-start)
2. Cursor: **Verify MCP Connection** → connected
3. **Refresh MCP Schema Snapshot** → `.ue5_8cursor/mcp-schema.json`
4. **Refresh Content Asset Index** → thumbnails when MCP online
5. Status bar: `MCP:8000`, `Assets:N`, `UHT:N`
6. Content Browser: filter / search / Copy Path
7. C++ `TEXT("/Game/...")` → **Shift+F12** (add a test path if none in project)
8. **Find Asset References** → 2-hop graph

## MCP capture for CI

With editor running:

```bash
npm run verify:project-mjs
```

This updates `schemas/ue58-mcp-captured.json` from live `describe_toolset` output.

## Known limitations

- `Content/` `.uasset` files may be gitignored — asset index count can be 0 offline
- Import DnD requires `ue58rider.experimental.assetImportDnD: true`
