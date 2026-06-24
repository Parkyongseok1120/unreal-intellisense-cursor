# UE5_8 Cursor

Cursor용 Unreal Engine 5.8 C++ 워크플로우 실험 저장소 (v6.x).  
Experimental Unreal Engine 5.8 C++ workflow for Cursor (v6.x).

---

## 한국어

### 프로젝트 상태

**실험 종료 (2026-06)** — clangd 기반 UE C++ IntelliSense를 Cursor 주력 IDE로 쓰는 시도는 **중단**했습니다.

검증 프로젝트 [**Project_MJS**](../Project_MJS) 기준 **MSVC(UBT) 빌드·에디터 실행은 정상**이었으나, IDE의 `source: clang` 진단이 소스 전반에서 빌드 결과와 어긋났습니다. **UE C++ 코딩 IDE는 [JetBrains Rider](https://www.jetbrains.com/rider/unreal/) 사용을 권장**합니다.

본 repo는 **성공·실패 기록과 재사용 가능한 코드(MCP, compile DB 자동화 등)** 를 남기는 아카이브입니다.

---

### 성공한 것들

#### 워크플로 · 자동화

| 항목 | 내용 |
|------|------|
| **Zero-Touch Bootstrap** | `.uproject` / 프로젝트 폴더 열 때 `.vscode/settings.json`, `.clangd`, `compile_commands.json`, `.cursor/mcp.json`, UHT IDE stubs 자동 생성 |
| **compile_commands 3단계 파이프라인** | `.Shared.rsp` 파싱 → UBT `GenerateClangDatabase` → `Build.cs` synthetic 폴백 |
| **IntelliSense 상태 표시** | Status bar `Ready \| Partial \| Missing` |
| **`.Shared.rsp` 감시** | 에디터 빌드 후 compile DB 자동 재생성 |
| **UE 5.8 전용 게이트** | `EngineAssociation` 5.8, 레지스트리·경로 자동 탐지 |
| **번들 clangd 19.1** | win32-x64 VSIX에 LLVM 포함 (별도 설치 불필요) |
| **cpptools 비활성 + clangd 단일 스택** | Microsoft C/C++ IntelliSense off, clangd on |

#### 빌드 · 에디터

| 항목 | 내용 |
|------|------|
| **UBT 빌드 태스크** | Build / Rebuild / Clean |
| **에디터 실행** | Launch Unreal Editor, Debug attach, PIE |
| **Live Coding** | Live Coding compile 명령 |
| **Class Wizard** | New C++ Class 템플릿 |

#### MCP · 에셋 · Blueprint (Cursor 강점 축)

| 항목 | 내용 |
|------|------|
| **UE Editor MCP 연동** | 포트 8000, `.cursor/mcp.json` 자동 구성, schema snapshot |
| **Epic MCP `call_tool` 브릿지** | 에디터 실행 중 툴셋 호출 |
| **Content Browser** | Tree / Webview, 필터·검색·Copy Path |
| **Asset index · 썸네일** | MCP online 시 에셋 인덱스·썸네일 |
| **Asset ReferenceProvider** | `TEXT("/Game/...")` → Shift+F12 |
| **참조 그래프** | Find Asset References (2-hop) |
| **Blueprint 브릿지** | Open BP, Find BP for class, Jump to C++ |
| **UHT reflection-index · CodeLens** | UFUNCTION 정보, BP usage 탐색 (부분) |
| **CI / 테스트** | `npm test`, MCP schema ajv 검증, Project_MJS integration test |

#### compile_commands 품질 (Project_MJS 실측)

- `.Shared.rsp` 기반 **Ready** 상태 달성
- AutoRTFM, Core, Engine UHT `-I`, `Definitions.Project_MJS.h`, SharedPCH `-include` 등 **UBT와 동일 플래그**를 JSON에 반영
- Project_MJS 모듈 `.cpp` **28개** 전부 compile DB 항목 등록

---

### 실패한 것들

#### 핵심 목표 미달성

| 목표 | 결과 |
|------|------|
| **Rider급 UE C++ IntelliSense** | **미달성** — fidelity Low–Medium 수준에서 정체 ([docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)) |
| **clang error = 빌드 문제** | **성립하지 않음** — MSVC 빌드 성공과 clang error 공존 |
| **clangd를 주력 UE IDE로 사용** | **중단** — Rider 권장 |

#### Project_MJS `clangd --check` (동일 compile_commands, v6.1.1 번들 clangd)

| 파일 / 상황 | clangd | MSVC 빌드 |
|-------------|--------|-----------|
| `EnemyCharacter.cpp`, `CPlayerCharacter.cpp` | **0 error** | 정상 |
| `FakeGIActor.cpp` | `UStaticMesh::StaticClass()` **error** | 정상 |
| `AttackComponent.cpp`, `SoundManagerSubsystem.cpp` | `UCFS_FChecker`, `GetNameSafe` **error** | 정상 |
| `CPlayerController.cpp` | `fatal_too_many_errors` | 정상 |
| `CinematicDirectorSubsystem.cpp` | `IsValid`, `GetComponents` 등 **error** | 정상 |
| 엔진 `Class.h` 탭 단독 | `AutoRTFM/Defines.h` → `uint32`/`UClass` **연쇄 error** | (엔진 헤더, 프로젝트 빌드와 무관) |

**패턴:** 프로젝트 UCLASS `StaticClass()`는 종종 통과, **엔진 UCLASS는 실패**. 설정 누락이 아니라 **UHT + MSVC PCH vs clangd 근사** 문제.

#### 구조적 한계

1. **이중 파이프라인** — 빌드: MSVC + UHT + SharedPCH / IDE: clangd + `compile_commands` 근사
2. **UHT 미실행** — `GENERATED_BODY`, `StaticClass()`, `TObjectPtr<>` 등 Rider 수준 의미 분석 불가
3. **MSVC SharedPCH** — clang이 `-include SharedPCH...h`를 완전히 소화하지 못함
4. **고아 엔진 헤더** — `Program Files/Epic Games/...` 아래 파일에 프로젝트 `.clangd` 미적용
5. **진단 suppress** — `.clangd`에서 `pp_file_not_found` 등 숨김 → **화면만 조용**, 이해는 개선 안 됨
6. **Blueprint 노드 그래프** — C++ ↔ BP 노드 수준 탐색은 MCP/editor 의존, clangd만으로 불가
7. **`.uasset` deep parse** — 헤더 휴리스틱 수준, 전체 파싱 미구현

#### 시도했으나 Rider급까지 못 간 것

- UHT IDE stubs (`UHTIDEStubs.h`) — 매크로 인식용, generated member 본문 없음
- reflection-index + CodeLens — Medium fidelity, Rider High 미도달
- SharedPCH 제거 / fallback `-I` — **실험 전 중단**, 대규모 before/after 미실시

---

### 결론 (한국어)

- **UE C++ 정확한 IntelliSense·리플렉션** → **Rider**
- **Cursor AI + 에디터 MCP + 에셋/Blueprint 브릿지** → 본 repo 코드 참고 가치 있음
- **compile_commands 자동 생성** → clangd 외 다른 도구·CI에서 재사용 가능
- Problems 패널: **`msCompile` error (severity 8)** 만 빌드 실패로 볼 것. `source: clang` + 엔진 경로는 대부분 무시 가능

---

### 후속 개발자에게

이 실험을 **이어가고 싶은 분**께 남기는 말입니다.

**먼저 읽을 것**

1. [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md) — 왜 clangd만으로 Rider급이 안 됐는지
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) — fork clangd / 별도 LSP는 비추천이라 적어 둔 이유
3. `src/cursor/bootstrapProject.ts`, `compileDatabaseFromRsp.ts` — 실제로 돌아가던 compile DB 파이프라인

**우리가 멈춘 이유를 다시 밟지 마세요**

- `compile_commands`가 Ready인데도 clang error가 남는 건 **설정 버그만이 아닙니다.** MSVC PCH + UHT + clangd 근사라는 구조 문제입니다.
- diagnostic suppress만 늘리면 Problems는 조용해지지만 **IntelliSense 품질은 거의 안 오릅니다.**
- “Rider급”을 목표로 clangd 설정만 튜닝하는 루프는 **수익 체감이 급격히 줄어듭니다.**

**그래도 가치 있는 방향**

| 방향 | 이유 |
|------|------|
| **MCP · 에셋 · Content Browser** | Cursor + 실행 중 에디터 연동은 여전히 차별점. Rider가 대체하기 어렵습니다. |
| **compile_commands 자동화** | clangd뿐 아니라 다른 분석기·CI·AI 컨텍스트에 쓸 수 있습니다. |
| **reflection-index / CodeLens 보강** | clangd를 대체하지 않고 **옆에서** UE semantics를 보완하는 쪽이 현실적입니다. |
| **SharedPCH 제거 실험** | `compileDatabaseFromRsp.ts`에서 MSVC PCH `-include` strip 후 **전 모듈 `clangd --check` before/after** — 우리는 대규모 실험 전에 중단했습니다. 여기서부터 재개해도 됩니다. |
| **Epic 공식 UE-aware LSP** | 나오면 그때 Cursor 어댑터만 얹는 편이 fork보다 낫습니다. |

**실험 재개 시 최소 체크리스트**

1. UE 5.8 게임 `.uproject` 루트를 workspace로 연다.
2. `npm test` + `clangd --check`를 **여러 모듈**에 돌려 before/after를 숫자로 남긴다.
3. 성공 기준을 미리 정한다 — 예: “Problems 0개”가 아니라 “엔진 `StaticClass` 오류 N% 감소” 또는 “MCP asset index 안정화”.
4. **빌드 실패는 msCompile만** 본다.

**혼자서 모든 걸 Cursor 주력 IDE로 만들 필요는 없습니다.**  
Rider로 C++ · Cursor로 AI/MCP를 나누는 것도 합리적인 종착점입니다. 이 repo는 그 판단을 내리기 전까지의 **로그와 부품 창고**로 두었습니다.

Pull request, issue, fork 모두 환영합니다. 다만 “clangd 설정 한 줄 바꿨는데 Rider 됐다” 식의 PR보다, **측정 가능한 before/after**가 있는 기여가 훨씬 도움이 됩니다.

---

## English

### Project Status

**Experiment ended (2026-06)** — We **stopped** pursuing clangd-based UE C++ IntelliSense as the primary Cursor IDE stack.

On validation project [**Project_MJS**](../Project_MJS), **MSVC (UBT) builds and the editor ran fine**, but IDE diagnostics (`source: clang`) disagreed with the compiler across much of the codebase. **We recommend [JetBrains Rider](https://www.jetbrains.com/rider/unreal/) for UE C++ IDE work.**

This repo is an **archive** of what worked, what failed, and reusable code (MCP, compile DB automation, etc.).

---

### What Worked

#### Workflow & automation

| Item | Details |
|------|---------|
| **Zero-Touch Bootstrap** | Auto-generates `.vscode/settings.json`, `.clangd`, `compile_commands.json`, `.cursor/mcp.json`, UHT IDE stubs on project open |
| **3-tier compile_commands pipeline** | `.Shared.rsp` parse → UBT `GenerateClangDatabase` → `Build.cs` synthetic fallback |
| **IntelliSense status bar** | `Ready \| Partial \| Missing` |
| **`.Shared.rsp` watcher** | Regenerates compile DB after editor builds |
| **UE 5.8-only gate** | `EngineAssociation` 5.8, registry/path discovery |
| **Bundled clangd 19.1** | LLVM in win32-x64 VSIX (no separate install) |
| **Single LSP stack** | cpptools IntelliSense disabled, clangd enabled |

#### Build & editor

| Item | Details |
|------|---------|
| **UBT build tasks** | Build / Rebuild / Clean |
| **Editor launch** | Launch Unreal Editor, debug attach, PIE |
| **Live Coding** | Live Coding compile command |
| **Class Wizard** | New C++ Class template |

#### MCP, assets & Blueprint (Cursor strength)

| Item | Details |
|------|---------|
| **UE Editor MCP** | Port 8000, auto `.cursor/mcp.json`, schema snapshot |
| **Epic MCP `call_tool` bridge** | Toolset calls while editor runs |
| **Content Browser** | Tree / Webview, filter, search, Copy Path |
| **Asset index & thumbnails** | When MCP is online |
| **Asset ReferenceProvider** | `TEXT("/Game/...")` → Shift+F12 |
| **Reference graph** | Find Asset References (2-hop) |
| **Blueprint bridge** | Open BP, find BP for class, jump to C++ |
| **UHT reflection-index & CodeLens** | UFUNCTION info, BP usage (partial) |
| **CI / tests** | `npm test`, MCP schema ajv validation, Project_MJS integration test |

#### compile_commands quality (Project_MJS, measured)

- **Ready** state from `.Shared.rsp`
- Flags mirror UBT: AutoRTFM, Core, Engine UHT `-I`, `Definitions.Project_MJS.h`, SharedPCH `-include`
- All **28** Project_MJS module `.cpp` files listed in compile DB

---

### What Did Not Work

#### Core goals not met

| Goal | Outcome |
|------|---------|
| **Rider-level UE C++ IntelliSense** | **Not achieved** — stuck at Low–Medium fidelity ([docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)) |
| **clang error implies bad code** | **False** — MSVC build OK while clang errors remain |
| **clangd as primary UE IDE** | **Discontinued** — use Rider instead |

#### Project_MJS `clangd --check` (same compile_commands, bundled clangd v6.1.1)

| File / scenario | clangd | MSVC build |
|-----------------|--------|------------|
| `EnemyCharacter.cpp`, `CPlayerCharacter.cpp` | **0 errors** | OK |
| `FakeGIActor.cpp` | `UStaticMesh::StaticClass()` **error** | OK |
| `AttackComponent.cpp`, `SoundManagerSubsystem.cpp` | `UCFS_FChecker`, `GetNameSafe` **errors** | OK |
| `CPlayerController.cpp` | `fatal_too_many_errors` | OK |
| `CinematicDirectorSubsystem.cpp` | `IsValid`, `GetComponents` **errors** | OK |
| Engine `Class.h` opened alone | `AutoRTFM/Defines.h` → `uint32`/`UClass` **cascade** | N/A (engine header) |

**Pattern:** project `UCLASS::StaticClass()` often passes; **engine types fail**. Not missing config — **UHT + MSVC PCH vs clangd approximation**.

#### Structural limits

1. **Dual pipeline** — build: MSVC + UHT + SharedPCH / IDE: clangd + `compile_commands` approximation
2. **No UHT execution** — no Rider-level `GENERATED_BODY`, `StaticClass()`, `TObjectPtr<>` semantics
3. **MSVC SharedPCH** — clang does not fully consume `-include SharedPCH...h`
4. **Orphan engine headers** — no project `.clangd` under `Program Files/Epic Games/...`
5. **Diagnostic suppress** — hides `pp_file_not_found` etc.; **UI only**, no real understanding
6. **Blueprint node graph** — needs MCP/editor; not clangd alone
7. **`.uasset` deep parse** — header heuristics only

#### Attempted but did not reach Rider level

- UHT IDE stubs — macro recognition only, no generated bodies
- reflection-index + CodeLens — Medium fidelity
- SharedPCH strip / fallback `-I` — **not run at scale** before shutdown

---

### Conclusion (English)

- **Accurate UE C++ IntelliSense & reflection** → **Rider**
- **Cursor AI + editor MCP + asset/Blueprint bridge** → this repo still useful as reference
- **compile_commands automation** → reusable for other tools / CI
- In Problems: trust **`msCompile` errors (severity 8)** for build failures. Ignore most `source: clang` on engine paths

---

### To those who continue this work

A note for anyone who wants to **pick this experiment back up**.

**Read these first**

1. [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md) — why clangd alone did not reach Rider level
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) — why we did not recommend forking clangd or building a separate UE LSP
3. `src/cursor/bootstrapProject.ts`, `compileDatabaseFromRsp.ts` — the compile DB pipeline that actually worked

**Do not repeat our dead ends**

- Clang errors with a **Ready** `compile_commands.json` are not **config bugs only**. They come from MSVC PCH + UHT + clangd approximation.
- Adding diagnostic suppress makes Problems quieter but **barely improves IntelliSense quality**.
- A loop of “tweak clangd flags until Rider-level” has **sharply diminishing returns**.

**Still worth pursuing**

| Direction | Why |
|-----------|-----|
| **MCP · assets · Content Browser** | Cursor + live editor integration remains a differentiator Rider does not replace easily. |
| **compile_commands automation** | Useful beyond clangd — CI, other analyzers, AI context. |
| **reflection-index / CodeLens** | Supplement UE semantics **beside** clangd instead of replacing it. |
| **SharedPCH strip experiment** | Strip MSVC PCH `-include` in `compileDatabaseFromRsp.ts`, then run **full-module `clangd --check` before/after** — we stopped before doing this at scale. A good restart point. |
| **Official Epic UE-aware LSP** | If it ships, adapt Cursor to it rather than maintaining a fork. |

**Minimum checklist if you restart**

1. Open a UE 5.8 game `.uproject` root as the workspace.
2. Run `npm test` + `clangd --check` on **many modules** and record before/after numbers.
3. Define success upfront — e.g. not “zero Problems” but “engine `StaticClass` errors down by N%” or “stable MCP asset index”.
4. Treat **msCompile only** as build failure.

**You do not have to make Cursor the only IDE for everything.**  
Rider for C++ · Cursor for AI/MCP is a valid end state. This repo is a **log and parts warehouse** until you choose your own landing point.

Pull requests, issues, and forks are welcome. Contributions with **measurable before/after** help far more than “one-line clangd tweak = Rider now” PRs.

---

## References · 참고

| Document | Description |
|----------|-------------|
| [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md) | clangd vs MSVC 빌드 분석 (한국어) |
| [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md) | clangd vs MSVC build analysis (English) |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) | UObject / clangd vs Rider research |

---

## Archive: build extension · 레거시 빌드

Experiment is closed; extension can still be built for reference.

```bash
npm install
npm run build
npm test
npm run package   # fetch-llvm + win32-x64 VSIX
```

Legacy commands (if installed): **Setup UE 5.8 Project**, **Refresh IntelliSense**, **Launch Unreal Editor**, **Verify MCP Connection**.

Key settings: `ue58rider.autoSetupOnOpen`, `ue58rider.engineRoot`, `ue58rider.llvmPath` (empty = bundled clangd).
