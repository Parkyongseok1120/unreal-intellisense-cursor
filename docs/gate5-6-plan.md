# Gate 5–6 개발·검증 계획

> v7.0.12 기준. 검증 프로젝트: `Project_MJS`

## 현재 베이스라인

| 영역 | 문서 점수 | 실질 완성도 | 블로커 |
|------|----------|------------|--------|
| Semantic | ~53% | ~36% | class line 버그, provider 기본 off, precision/recall 미측정 |
| UHT | ~62% | ~44% | inspection 5개, authoritative/heuristic 혼재 |
| Workflow (Gate 6) | ~61% | ~40–50% | Bridge BP/PIE/logs stub, delta assets 없음 |
| 종합 | ~66% | ~44–50% | 측정 harness 없음 |

## 아키텍처 원칙

- **recursive clangd 호출 금지** — `ueNavigationCommands.ts`에서 1회만 위임
- **UE provider는 overlay만** — 일반 C++는 clangd에 위임
- **점수는 corpus benchmark에서 자동 산출** — `collect-quality-metrics.mjs` 수동 입력 제거

## Phase 0 — 검증 인프라 (3–4일)

### 산출물

- `test/fixtures/navigation-corpus/` — Definition/Reference/Hierarchy golden cases
- `test/fixtures/uht-corpus/` — UHT error/warning + FP corpus
- `scripts/benchmark-navigation.mjs`
- `scripts/benchmark-uht.mjs`
- `test/navigation-corpus.test.mjs`, `test/uht-corpus.test.mjs`

### P0 완료 기준

- corpus 50+ nav / 30+ UHT 케이스
- harness 숫자 산출 → `ci-baseline.json` 반영
- class line fix 후 hierarchy 케이스 pass

## Gate 5 — Semantic + UHT (15–22일)

**목표:** Semantic 32→81, UHT 48→82, 종합 66→72

### 5.1 Symbol model

- `UClassReflection`에 `classLine`, `declarationRange`
- `parseUClassFromText()` 연동
- stable symbol ID: `module@canonicalType@uri`
- UFUNCTION/UPROPERTY → graph `members[]`

### 5.2 Overlay architecture

- overlay-only 반환, clangd 1회 위임
- `UeSemanticReferenceProvider` 구현
- `findUeReferences` graph 연동
- BNE `_Implementation` cpp 검색

### 5.3 References + Hierarchy

- `UeSemanticTypeHierarchyProvider` declarationRange
- incremental graph per-header refresh

### 5.4 UHT authoritative

- manifest target별 cache key
- cancelled result 폐기
- inspection/UHT cache 분리
- char literal / raw string / preprocessor scanner

### Gate 5 수용 기준

| 기준 | 목표 |
|------|------|
| Definition precision | 99% |
| Reference precision / recall | 98% / 85% |
| Hierarchy accuracy | 95% |
| UHT error recall / location | 98% / 99% |
| Heuristic error FP | 0% |
| Heuristic warning FP | <0.5% |

**Exit:** `release:scorecard` semantic≥81, uht≥82. **버전:** v7.2.0

## Gate 6 — Blueprint·Asset·Test·Debug·Log·HLSL (20–30일)

**목표:** 종합 72→80~83

### 6.1 Bridge C++ 구현

- `blueprint.listDerived`, `blueprint.findImplementations`, `blueprint.propertyOverrides`
- `assetRegistry` paging + delta
- `pie.getState`, `logs.tail`

### 6.2–6.7 영역별

| 영역 | 핵심 gap |
|------|---------|
| Blueprint | derived/override/interface, BP compile errors |
| Assets | GetAllAssets loop, FARFilter, delta, referencer |
| Test Explorer | debug profile, file/line, crash reconnect |
| Debug | compound, Server DebugGame, Stop Multiplayer, PIE state |
| Logs | rotation filename, partial line, UTF-8, source link |
| HLSL | hlsl-tools LSP, ShaderCompileWorker diagnostic mapping |

**버전:** v8.0.0

## 개발–검증 반복 사이클

```
Implement → unit/corpus test → benchmark:* → Project_MJS 수동 → hotfix → collect:quality-metrics
```

주간: 월–수 구현, 목 corpus/CI, 금 Project_MJS E2E + scorecard.
