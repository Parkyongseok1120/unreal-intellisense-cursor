# Changelog

## 7.0.0 — Rider 60% UE Workflow Release (Trust Reset)

- **Gate 0 Trust Reset:** Inaccurate TypeHierarchy/Reference/DocumentSymbol providers gated off by default; UE inspections default off (5 safe rules when enabled); TestController no false-pass; failed-test set; capability-gated Bridge client
- **Gate 1 Schemas:** `schemas/editor-bridge-v1.json`, `bridgeProtocol.ts` TS/C++ method registry, BuildSnapshot v2 (`authoritativeActions`/`ideActions`/`parity`), `WorkspaceProjectRegistry`
- **Gate 2 Collectors:** C++ `automation.status`/`automation.cancel`; asset list `offset`; RSP importer improvements (no full DB replacement); input fingerprints
- **Gate 3+:** Semantic/UHT re-enable via `ue58rider.semantic.navigation.enabled` and `ue58rider.uht.inspections.enabled` settings
- **Gate 4:** Multiplayer debug aligned with `baseCppDebuggerOptions` + multi-client launch; HLSL without fake directory completions
- **Gate 5:** Behavioral `verify:rider-workflow`, `release:scorecard`, CI integration, `test:ue-e2e` placeholder for self-hosted Editor

## 7.0.0 — Rider 60% UE Workflow Release

- **6.6.2 Release Gate:** `.gitattributes` + CI `git diff --check`; safe `BuildPlugin` spawn; fork PR plugin-build policy; dead `bridge.autoInstallPlugin` removed; Class Wizard transaction + UserWidget UMG consent; fixture temp-copy helper; bridge protocol contract tests; expanded extension-host E2E
- **6.7 Authoritative Model:** `BuildSnapshot` with UBT/RSP importers, fingerprint/generation on semantic graph, status bar provenance (`Ready|Partial|Stale|Missing`), multi-root `ProjectSession` map
- **6.8 Semantic + UHT:** UE navigation providers (definition/reference/symbols/hierarchy/inlays), 12 UE inspections, UHT scheduler redesign (active doc, cache, coalescing)
- **6.9 Bridge Slice:** VS Code `TestController` for automation tests, Blueprint RPCs, paginated asset registry, `automation.status` polling
- **7.0 Workflow:** `ue58rider.debugMultiplayer`, structured log viewer filters, HLSL engine include paths, `npm run verify:rider-workflow`

## 6.6.1 — Release Gate (P0 safety)

- UE58CursorBridge: UE 5.8 API fixes (HttpServer response, Automation list/run), assetRegistry pagination, route-only shutdown
- `npm run build:ue-plugin` + self-hosted CI `plugin-build` job (requires `UE_ROOT`)
- Editor Bridge: RPC timeout/response size limits, fail-soft client, token secrets cache, `.ue5_8cursor/` gitignore
- Plugin install: consent-gated `ue58rider.installCursorBridgePlugin` command; auto-copy removed from detection
- UHT Quick Fix: unsafe `_Implementation` stub disabled; GENERATED_BODY/UFUNCTION only
- Extension host: `test/run-extension-host.mjs` with `@vscode/test-electron`
- Encoding audit expanded to all `src/`, snippets, docs; status bar shows compile parity %

## 6.6.0 — UE Semantic Service (Milestones 6.3–6.6)

- SemanticGraph: persisted `.ue5_8cursor/semantic-graph.json` with modules, reflection, compile actions, plugins, targets
- SemanticService API: `buildGraph`, `querySymbol`, `queryModule`, compile parity reporting
- UHT diagnostic pipeline: `uhtDiagnostics`, save/header triggers, `UhtCodeActionProvider`, separate Problems collection
- Editor Bridge v1: HTTP JSON-RPC protocol, descriptor file, TS client connect/handshake, AssetRegistry + Automation RPCs
- UE58CursorBridge plugin: descriptor writer, bootstrap copy into project Plugins/
- Asset index prefers Editor Bridge authoritative entries when online
- Tests: semantic-service, uht-diagnostics, editor-bridge mock RPC; `audit:encoding` script

## 6.2.1 — Reliability Hotfix (Milestone 0)

- WorkspaceMutationTransaction: hash-based backups, journal, commit/rollback, mutex, policy downgrade prevention
- All bootstrap/setup writes routed through transaction API (settings, MCP, launch, compile DB, rules)
- ProjectSession: await previous pipeline, write-job serialization, generation stale checks
- Warm-up and compile refresh moved into session jobs with cancellation propagation
- SourceWatcher: pending-set batching, `uhtModule` classification, delete handling
- `addTranslationUnitAction` disabled by default; `ue58rider.experimental.incrementalCompileDb` flag
- Scaffold cleanup: fake tests removed, EditorBridge offline `capabilities: []`, HLSL behind experimental flag
- UE58CursorBridge `.uplugin`: ModelContextProtocol entry removed (scaffold, not installed)
- README status corrected; `verify:ue-project` CLI; mutation/session/watcher regression tests

## 6.2.0 — Reliable Unreal Workspace (Milestone 0)

- CommandBridge: Bearer token auth, allowlist, request size/schema validation, bridge file cleanup on dispose
- WorkspaceMutationService: atomic writes, JSON validation, backup snapshots, consent-gated `.uproject` changes
- `mcp.autoFixUproject` default changed to `false` with explicit consent dialog
- Explorer filter reset preserves user-defined exclude patterns
- sourceWatcher: fixed new-file-in-existing-module bug; event-scoped invalidation (TU/reflection/module/project)
- ProjectSession: single-flight detection pipeline, cancellation, generation IDs, stable CommandBridge lifecycle
- Class Wizard: correct UINTERFACE `U`/`I` naming; UserWidget drops `UMGEditor`; safer Build.cs dependency insertion
- clangd: removed global diagnostic suppress list; status bar marks provisional/synthetic compile DB
- ProjectModelService foundation, UHT runner, Editor Bridge client, UE58CursorBridge plugin scaffold
- Tests: security, mutation, invalidation, wizard, smoke, parity, UHT parser; synthetic UE fixture; uasset fixture
- Version/branding: single source from `package.json`; repository URL corrected

## 5.4.0

- `contentBrowserUi` 설정 연동 (`tree` / `webview` / `both`)
- Content Browser Webview: MCP 썸네일, 클래스 필터, 페이지네이션, 컨텍스트 메뉴
- `assetThumbnailService`, `assetClassIcons` 공통 헬퍼
- Experimental asset import DnD (`ue58rider.experimental.assetImportDnD`)
- `importAsset` MCP logical tool + resolver 키워드
- `uassetReader` v2 name table 휴리스틱
- clangd `-I` 경로 dedup
- ajv CI schema validation
- MCP captured schema + tool subset 테스트 강화

## 5.0.0

- v4.1–v5.0 로드맵: indexCoordinator, ReferenceProvider, MCP diagnostics, status bar, uasset lite v1

## 4.0.0

- Epic MCP `call_tool`, Content Browser TreeView, 참조 그래프, UHT reflection-index
