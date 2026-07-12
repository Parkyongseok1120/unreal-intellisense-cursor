# Changelog

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
