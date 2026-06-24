# UE5_8 Cursor

Experimental Unreal Engine 5.8 C++ workflow for Cursor (v6.x).  
Cursor용 Unreal Engine 5.8 C++ 워크플로우 실험 저장소 (v6.x).

---

## English

### Project Status

**Experiment ended (2026-06)** — We stopped pursuing **Rider-class UE C++ IntelliSense through clangd alone** in this extension.

On a UE 5.8 game project, **MSVC (UBT) builds and the editor ran fine**. Many `source: clang` diagnostics still disagreed with the real compiler — a **Unreal (MSVC + UHT + PCH) vs generic clangd** mismatch that affects any clangd-based editor setup, not something specific to Cursor or VS Code.

**Cursor is still a strong fit** for AI-assisted work, MCP, and the automation in this repo. Teams that need full UObject/reflection IDE features often **also** use [JetBrains Rider](https://www.jetbrains.com/rider/unreal/) or **Visual Studio** (Unreal workload) for that layer — complementary tools, not a verdict against Cursor.

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
| **CI / tests** | `npm test`, MCP schema ajv validation, bootstrap & integration tests |

#### compile_commands quality (measured)

- **Ready** state from `.Shared.rsp`
- Flags mirror UBT: AutoRTFM, Core, Engine UHT `-I`, `Definitions.<Module>.h`, SharedPCH `-include`
- All primary game module `.cpp` files listed in compile DB

---

### What Did Not Work

#### Core goals not met

| Goal | Outcome |
|------|---------|
| **Rider-level UE C++ IntelliSense via clangd** | **Not achieved** — stuck at Low–Medium fidelity ([docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)) |
| **clang error implies bad code** | **False** — MSVC build OK while clang errors remain |
| **clangd as the sole UE semantic engine** | **Out of scope for this archive** — full UObject/reflection IDE is a separate toolchain layer (Rider, Visual Studio, etc.) |

#### `clangd --check` sampling (same compile_commands, bundled clangd v6.1.1)

| Category | clangd | MSVC build |
|----------|--------|------------|
| Character module (some) | **0 errors** | OK |
| Graphics / actor module | `UStaticMesh::StaticClass()` **error** | OK |
| Combat / component module | `UCFS_FChecker`, `GetNameSafe` **errors** | OK |
| Controller module | `fatal_too_many_errors` | OK |
| Cinematic subsystem | `IsValid`, `GetComponents` **errors** | OK |
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

### Performance & resources

What we observed for **speed, memory, and load** during the experiment. (Exact numbers vary by project size and hardware.)

#### Design choices that helped

| Item | Notes |
|------|-------|
| **Zero-Touch bootstrap** | Generates `.vscode` / `.clangd` / MCP config in **seconds** — separate from full UBT build |
| **`.Shared.rsp` → compile_commands** | After **one editor build**, RSP parsing is **relatively fast** (no full UBT rerun for DB refresh) |
| **Background UHT warm-up** | `autoWarmUnrealCacheOnOpen` — UBT Editor build runs **without blocking** extension activation |
| **cpptools disabled** | Single **clangd LSP** — one language server for C++ in this experiment (avoids duplicate indexing) |
| **Source watcher debounce** | `.Shared.rsp` **5s**, source changes **15s**, reflection **5s** — reduces regenerate storms on save |
| **Explorer filter** | Hides `Intermediate` / `Binaries` / `Content` — less explorer and watcher noise |

#### Expensive phases (bottlenecks)

| Phase | Typical feel | Cause |
|-------|--------------|-------|
| **First open + clangd indexing** | **Minutes**, RAM spike | `--background-index`, **hundreds of `-I` per TU**, `--pch-storage=memory` |
| **UBT Editor warm-up / first build** | **Minutes to tens of minutes** | UHT + full module compile; prerequisite for Ready IntelliSense |
| **`compile_commands.json` size** | **Multi-MB** possible | Long per-TU command lines (engine + plugin includes) |
| **clangd `--check` / one file** | **~10–20s+** | Large PCH force-include + include fan-out |
| **Bundled LLVM in VSIX** | **~150MB** | clangd 19.1 in package (not in git; shipped via Release) |
| **`--clang-tidy` always on** | Extra CPU | Default in generated `clangd.arguments` |
| **`-j=12`** | Up to 12 threads | Parallel parse/index — fan/throttle on low-end machines |

#### Default clangd / `.clangd` (generated by this repo)

```
--background-index
--clang-tidy
--pch-storage=memory
--limit-results=500
-j=12
```

`.clangd`: `Index: Background: Build`, `CompilationDatabase: .`, UHT stubs `-include`, many Intermediate `-I` paths.

#### Performance-related limits

- **Accuracy vs load** — fewer includes/PCH/index → often **more** false errors, not less CPU in all cases.
- **IntelliSense Ready ≠ lightweight** — Ready means compile DB quality, not low RAM/CPU.
- **Large UE trees + generic clangd** — indexing can be RAM/CPU-heavy and slow to warm up; UE-native IDEs use different indexes. Tune `-j` and `--clang-tidy` on smaller machines.
- **MCP / asset index** — lightweight when editor is off (empty index); editor + MCP adds network and editor load.
- **SharedPCH strip** — not measured before shutdown; impact on parse speed unknown.

#### Tuning hints for future use

1. Low-end PC: try `-j=4` instead of `-j=12`, consider removing `--clang-tidy`.
2. Index load: disabling `--background-index` weakens completion — use only if needed.
3. `autoRefreshOnSourceChange: false` — saves CPU on large teams / frequent saves.
4. **One editor build**, then Refresh IntelliSense — Ready (RSP) beats Partial (synthetic) for **less re-parse waste**.
5. **Multi-tool workflow (optional):** some teams use Rider or Visual Studio for deep C++ navigation and **keep Cursor for AI/MCP** — running two clangd instances for the same project is usually worth avoiding.

---

### Conclusion

- **Full UE C++ reflection / UObject IDE semantics** → often handled with **Rider or Visual Studio** (Epic’s usual toolchain partners)
- **Cursor + this extension** → AI, editor MCP, asset/Blueprint bridge, compile DB automation — **where this experiment still adds value**
- **compile_commands automation** → reusable for clangd, other analyzers, CI, AI context
- In Problems: trust **`msCompile` errors (severity 8)** for build failures. Treat most `source: clang` on engine paths as IDE noise, not proof the game is broken

---

### To those who continue this work

A note for anyone who wants to **pick this experiment back up**.

**Read these first**

1. [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md) — why clangd alone did not reach Rider level
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) — why we did not recommend forking clangd or building a separate UE LSP
3. `src/cursor/bootstrapProject.ts`, `compileDatabaseFromRsp.ts` — the compile DB pipeline that actually worked

**Lessons from our dead ends**

- Clang errors with a **Ready** `compile_commands.json` are not **config bugs only**. They come from MSVC PCH + UHT + clangd approximation — a UE ecosystem constraint, not a Cursor defect.
- Adding diagnostic suppress makes Problems quieter but **barely improves IntelliSense quality**.
- A loop of “tweak clangd flags until Rider-level” has **sharply diminishing returns** for this approach.

**Still worth pursuing**

| Direction | Why |
|-----------|-----|
| **MCP · assets · Content Browser** | Cursor + live editor integration is a real strength — worth extending regardless of which C++ IDE you use. |
| **compile_commands automation** | Useful beyond clangd — CI, other analyzers, AI context. |
| **reflection-index / CodeLens** | Supplement UE semantics **beside** clangd instead of replacing it. |
| **SharedPCH strip experiment** | Strip MSVC PCH `-include` in `compileDatabaseFromRsp.ts`, then run **full-module `clangd --check` before/after** — we stopped before doing this at scale. A good restart point. |
| **Official Epic UE-aware LSP** | If it ships, adapt Cursor to it rather than maintaining a fork. |

**Minimum checklist if you restart**

1. Open a UE 5.8 game `.uproject` root as the workspace.
2. Run `npm test` + `clangd --check` on **many modules** and record before/after numbers.
3. Define success upfront — e.g. not “zero Problems” but “engine `StaticClass` errors down by N%” or “stable MCP asset index”.
4. Treat **msCompile only** as build failure.

**Using more than one tool is normal.**  
Rider or Visual Studio for C++ navigation · Cursor for AI/MCP is a common split. This repo is a **log and parts warehouse** for the Cursor side of that workflow.

Pull requests, issues, and forks are welcome. Contributions with **measurable before/after** are especially helpful.

---

## 한국어

### 프로젝트 상태

**실험 종료 (2026-06)** — 이 확장에서 **clangd만으로 Rider급 UE C++ IntelliSense**를 맞추는 시도는 **중단**했습니다.

UE 5.8 게임 프로젝트에서 **MSVC(UBT) 빌드·에디터 실행은 정상**이었습니다. 그런데 `source: clang` 진단은 실제 컴파일러와 자주 어긋났습니다. 이는 **Unreal(MSVC + UHT + PCH) vs 범용 clangd** 구조 차이로, Cursor나 VS Code만의 문제가 아닙니다.

**Cursor는 AI·MCP·자동화** 측면에서 여전히 강합니다. UObject/리플렉션까지 IDE 수준으로 쓰려는 팀은 **[JetBrains Rider](https://www.jetbrains.com/rider/unreal/)** 또는 **Visual Studio**(Unreal 워크로드)를 **함께** 쓰는 경우가 많습니다 — Cursor를 부정하는 게 아니라 역할 분담입니다.

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
| **cpptools 비활성 + clangd 단일 스택** | Microsoft C/C++ IntelliSense off, clangd on — 이 실험에서는 C++ LSP를 하나로 통일 (이중 인덱싱 방지) |

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
| **CI / 테스트** | `npm test`, MCP schema ajv 검증, bootstrap·integration test |

#### compile_commands 품질 (실측)

- `.Shared.rsp` 기반 **Ready** 상태 달성
- AutoRTFM, Core, Engine UHT `-I`, `Definitions.<Module>.h`, SharedPCH `-include` 등 **UBT와 동일 플래그**를 JSON에 반영
- 게임 Primary 모듈 `.cpp` 전부 compile DB 항목 등록

---

### 실패한 것들

#### 핵심 목표 미달성

| 목표 | 결과 |
|------|------|
| **clangd만으로 Rider급 UE C++ IntelliSense** | **미달성** — fidelity Low–Medium 수준에서 정체 ([docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)) |
| **clang error = 빌드 문제** | **성립하지 않음** — MSVC 빌드 성공과 clang error 공존 |
| **clangd를 UE 의미 분석의 유일 엔진으로** | **이 아카이브 범위 밖** — full UObject/리플렉션 IDE는 Rider·Visual Studio 등 별도 툴체인 영역 |

#### `clangd --check` 샘플링 (동일 compile_commands, v6.1.1 번들 clangd)

| 유형 | clangd | MSVC 빌드 |
|------|--------|-----------|
| 캐릭터 모듈 (일부) | **0 error** | 정상 |
| 그래픽/액터 모듈 | `UStaticMesh::StaticClass()` **error** | 정상 |
| 전투/컴포넌트 모듈 | `UCFS_FChecker`, `GetNameSafe` **error** | 정상 |
| 컨트롤러 모듈 | `fatal_too_many_errors` | 정상 |
| 시네마틱 서브시스템 | `IsValid`, `GetComponents` 등 **error** | 정상 |
| 엔진 `Class.h` 탭 단독 | `AutoRTFM/Defines.h` → `uint32`/`UClass` **연쇄 error** | (엔진 헤더, 게임 빌드와 무관) |

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

### 성능 · 리소스

실험 중 체감한 **속도·메모리·부하** 정리입니다. (정확한 벤치마크 수치는 프로젝트 규모·머신에 따라 다름)

#### 잘 맞았던 설계 (체감 성능)

| 항목 | 내용 |
|------|------|
| **Zero-Touch 부트스트랩** | `.vscode` / `.clangd` / MCP 설정만 생성 — **수초~수십 초**, UBT full build와 분리 |
| **`.Shared.rsp` → compile_commands** | 에디터 **1회 빌드 후** RSP 파싱은 **상대적으로 빠름** (UBT 재실행 없이 DB 갱신) |
| **백그라운드 UHT warm-up** | `autoWarmUnrealCacheOnOpen` — UBT Editor 빌드를 **활성화를 막지 않고** 백그라운드 실행 |
| **cpptools 비활성** | Microsoft C/C++ IntelliSense off → **clangd 단일 LSP** (이 실험에서 C++ 서버 하나로 통일) |
| **소스 감시 debounce** | `.Shared.rsp` **5초**, 소스 변경 **15초**, reflection **5초** — 저장 연타 시 regenerate 폭주 완화 |
| **Explorer filter** | `Intermediate` / `Binaries` / `Content` 등 탐색기·watcher 노이즈 감소 |

#### 비용이 큰 구간 (병목)

| 구간 | 체감 | 원인 |
|------|------|------|
| **첫 프로젝트 열기 + clangd 인덱싱** | **수 분~십수 분**, RAM 상승 | `--background-index`, UE TU당 **수백 `-I`**, `--pch-storage=memory` |
| **UBT Editor warm-up / 첫 빌드** | **수 분~수십 분** | UHT + 전 모듈 컴파일; IntelliSense Ready 전제 |
| **`compile_commands.json` 크기** | **수 MB** 가능 | TU마다 긴 command line (엔진·플러그인 `-I` 전부) |
| **clangd `--check` / 진단 1파일** | **~10–20초+** | 대형 PCH force-include + include 폭 |
| **VSIX 번들 LLVM** | **~150MB** | `bin/` clangd 19.1 (git 미포함, Release에 VSIX) |
| **`--clang-tidy` 항상 on** | CPU 추가 | `workspaceSetup` 기본 clangd args에 포함 |
| **`-j=12`** | CPU 12스레드 | clangd 병렬 파싱·인덱스 — 저사양 PC에서 팬·스로틀 |

#### 기본 clangd / `.clangd` 설정 (repo가 생성)

```
--background-index
--clang-tidy
--pch-storage=memory
--limit-results=500
-j=12
```

`.clangd`: `Index: Background: Build`, `CompilationDatabase: .`, UHT stubs `-include`, Intermediate `-I` 다수 추가.

#### 성능 관련 실패·한계

- **정확도를 올리려면 부하도 올라감** — include·PCH·background index를 줄이면 오류는 더 늘 수 있음 (trade-off).
- **IntelliSense Ready ≠ 가벼움** — Ready는 compile DB 품질 지표이지, clangd가 가볍다는 뜻이 아님.
- **대형 UE + 범용 clangd** — 인덱싱·RAM/CPU 부담과 warm-up 시간이 클 수 있음. UE 전용 IDE는 다른 인덱스를 씀. 저사양 PC에서는 `-j`, `--clang-tidy` 조절.
- **MCP·asset index** — 에디터 꺼져 있으면 index 0·썸네일 없음 (가벼움); 에디터 + MCP on 시 네트워크·에디터 부하 추가.
- **SharedPCH strip 미실시** — PCH 제거가 파싱·속도에 미치는 영향은 **실험 종료 전 측정하지 않음**.

#### 후속 개발·사용 시 튜닝 힌트

1. 저사양 PC: `clangd.arguments`에서 `-j=12` → `-j=4`, `--clang-tidy` 제거 검토.
2. 인덱스 부담: `--background-index` off는 completion 약화 — 필요 시만.
3. `autoRefreshOnSourceChange: false` — 대형 팀/잦은 저장 시 regenerate CPU 절약.
4. **에디터 1회 빌드 후** Refresh IntelliSense — synthetic(Partial) 상태보다 RSP(Ready)가 **재시작·재파싱 낭비 적음**.
5. **멀티 툴 워크플로(선택):** Rider/VS로 C++ 탐색 + **Cursor는 AI/MCP** — 같은 프로젝트에 clangd를 두 번 띄우는 건 보통 피하는 편.

---

### 결론

- **UE C++ full 리플렉션 / UObject IDE 의미 분석** → **Rider 또는 Visual Studio**로 맡기는 팀이 많음 (Epic 생태계 일반 조합)
- **Cursor + 이 확장** → AI, 에디터 MCP, 에셋/Blueprint 브릿지, compile DB 자동화 — **실험이 여전히 가치 있는 부분**
- **compile_commands 자동 생성** → clangd, 다른 분석기, CI, AI 컨텍스트에 재사용 가능
- Problems 패널: **`msCompile` error (severity 8)** 만 빌드 실패로 볼 것. `source: clang` + 엔진 경로는 IDE 노이즈로 보는 편이 안전

---

### 후속 개발자에게

이 실험을 **이어가고 싶은 분**께 남기는 말입니다.

**먼저 읽을 것**

1. [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md) — 왜 clangd만으로 Rider급이 안 됐는지
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) — fork clangd / 별도 LSP는 비추천이라 적어 둔 이유
3. `src/cursor/bootstrapProject.ts`, `compileDatabaseFromRsp.ts` — 실제로 돌아가던 compile DB 파이프라인

**우리가 겪은 함정 (참고)**

- `compile_commands`가 Ready인데도 clang error가 남는 건 **설정 버그만이 아닙니다.** MSVC PCH + UHT + clangd 근사 — UE 생태계 제약이지 Cursor 결함이 아닙니다.
- diagnostic suppress만 늘리면 Problems는 조용해지지만 **IntelliSense 품질은 거의 안 오릅니다.**
- “Rider급”을 목표로 clangd 설정만 튜닝하는 루프는 **수익 체감이 급격히 줄어듭니다.**

**그래도 가치 있는 방향**

| 방향 | 이유 |
|------|------|
| **MCP · 에셋 · Content Browser** | Cursor + 실행 중 에디터 연동은 확실한 강점 — C++ IDE를 무엇을 쓰든 확장할 가치가 있음. |
| **compile_commands 자동화** | clangd뿐 아니라 다른 분석기·CI·AI 컨텍스트에 쓸 수 있습니다. |
| **reflection-index / CodeLens 보강** | clangd를 대체하지 않고 **옆에서** UE semantics를 보완하는 쪽이 현실적입니다. |
| **SharedPCH 제거 실험** | `compileDatabaseFromRsp.ts`에서 MSVC PCH `-include` strip 후 **전 모듈 `clangd --check` before/after** — 우리는 대규모 실험 전에 중단했습니다. 여기서부터 재개해도 됩니다. |
| **Epic 공식 UE-aware LSP** | 나오면 그때 Cursor 어댑터만 얹는 편이 fork보다 낫습니다. |

**실험 재개 시 최소 체크리스트**

1. UE 5.8 게임 `.uproject` 루트를 workspace로 연다.
2. `npm test` + `clangd --check`를 **여러 모듈**에 돌려 before/after를 숫자로 남긴다.
3. 성공 기준을 미리 정한다 — 예: “Problems 0개”가 아니라 “엔진 `StaticClass` 오류 N% 감소” 또는 “MCP asset index 안정화”.
4. **빌드 실패는 msCompile만** 본다.

**툴을 여러 개 쓰는 건 흔한 일입니다.**  
Rider/VS로 C++ 탐색 · Cursor로 AI/MCP — 이런 분업도 자연스럽습니다. 이 repo는 그중 **Cursor 쪽** 로그와 부품 창고입니다.

Pull request, issue, fork 모두 환영합니다. **측정 가능한 before/after**가 있는 기여가 특히 도움이 됩니다.

---

## References · 참고

| Document | Description |
|----------|-------------|
| [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md) | clangd vs MSVC build analysis (English) |
| [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md) | clangd vs MSVC 빌드 분석 (한국어) |
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
