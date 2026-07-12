# Unreal Engine 5.8 IntelliSense Cursor VSIX

```text
Project status: Active development
Current milestone: **6.6.1 Release Gate** (UE plugin compile CI, Bridge security, consent-based install)

Milestone 0 (6.2.1) reliability complete. **6.3–6.6 UE Semantic Service** (Semantic Graph, UHT diagnostics, Editor Bridge) landed in 6.6.0; 6.6.1 hardens deploy safety before 6.7 authoritative model work.
Production ready: No
Rider replacement: Not yet
Supported engine: UE 5.8
Supported host: Cursor on Windows
```

Cursor에서 UE 5.8 C++ 환경을 조금 더 편하게 써보려고 만든 실험 확장입니다.  
처음에는 “Cursor에서도 Unreal C++ IntelliSense를 꽤 쓸만하게 만들 수 있지 않을까?” 정도의 생각으로 시작했는데, 파고들다 보니 UBT, `compile_commands.json`, clangd, UHT, PCH, 모듈 의존성까지 꽤 깊게 들어가게 됐습니다.

**2026-06에 일시 중단했던 실험이 reliability-first 방향으로 재개되었습니다.**  
Milestone 0 (6.2.1) 신뢰성 기반 완료 후, **6.3–6.6 UE Semantic Service** (통합 그래프, UHT 진단, Editor Bridge)를 진행 중입니다.

Experimental Unreal Engine 5.8 C++ workflow extension for Cursor.  
This is not a finished Rider replacement. Active development continues with a reliability-first roadmap.

---

## English

### Project Status

**Active development — reliability foundation (6.2.x).**

The original goal was to see how far we could push **UE 5.8 C++ IntelliSense in Cursor using clangd**. Development paused in 2026-06 but has resumed with Milestone 0 reliability fixes (6.2.1): transactional workspace writes, session job scheduling, watcher batching, and safer compile DB refresh.

On an actual UE 5.8 game project, **MSVC builds and the Unreal Editor worked fine**. The issue was that the Problems panel still showed many `source: clang` errors that did not match the real build result.

That is not really “Cursor is broken” or “VS Code is bad.” It is mostly the gap between:

- Unreal’s real build pipeline: **MSVC + UBT + UHT + SharedPCH**
- The IDE-side approximation: **clangd + compile_commands.json**

Cursor is still useful for **AI, MCP, editor automation, assets, and Blueprint-related workflows**. But for deep UObject/reflection-aware C++ navigation, many teams will still want **Rider** or **Visual Studio with the Unreal workload** nearby.

So this repository should be read as:

> a development log, an archive, and a parts shelf for people who want to continue experimenting with Cursor + Unreal.

---

### What Worked

#### Workflow & automation

| Item | Details |
|------|---------|
| **Zero-Touch Bootstrap** | Generates `.vscode/settings.json`, `.clangd`, `compile_commands.json`, `.cursor/mcp.json`, and UHT IDE stubs when opening a project |
| **3-tier compile_commands pipeline** | `.Shared.rsp` parse → UBT `GenerateClangDatabase` → `Build.cs` synthetic fallback |
| **IntelliSense status bar** | Shows `Ready`, `Partial`, or `Missing` |
| **`.Shared.rsp` watcher** | Regenerates compile DB after editor builds |
| **UE 5.8-only gate** | Checks `EngineAssociation` 5.8 and discovers engine paths from registry/filesystem |
| **Bundled clangd 19.1** | LLVM included in win32-x64 VSIX, so no separate install is required |
| **Single C++ LSP stack** | Disables cpptools IntelliSense and uses clangd only |

#### Build & editor

| Item | Details |
|------|---------|
| **UBT build tasks** | Build / Rebuild / Clean |
| **Editor launch** | Launch Unreal Editor, debug attach, PIE |
| **Live Coding** | Live Coding compile command |
| **Class Wizard** | New C++ Class template |

#### MCP, assets & Blueprint

This part is probably the most useful side of the project.

| Item | Details |
|------|---------|
| **UE Editor MCP** | Port 8000, auto `.cursor/mcp.json`, schema snapshot |
| **Epic MCP `call_tool` bridge** | Calls editor tools while Unreal Editor is running |
| **Content Browser** | Tree / Webview, filter, search, Copy Path |
| **Asset index & thumbnails** | Available when MCP is online |
| **Asset ReferenceProvider** | `TEXT("/Game/...")` → Shift+F12 |
| **Reference graph** | Find Asset References, up to 2-hop traversal |
| **Blueprint bridge** | Open BP, find BP for class, jump to C++ |
| **UHT reflection-index & CodeLens** | UFUNCTION info and BP usage, partially working |
| **CI / tests** | `npm test`, MCP schema ajv validation, bootstrap and integration tests |

#### compile_commands quality

The compile database pipeline itself was not useless. The `.Shared.rsp` path produced a **Ready** state, and the generated commands reflected many UBT flags, including:

- AutoRTFM
- Core / Engine UHT include paths
- `Definitions.<Module>.h`
- SharedPCH `-include`
- primary game module `.cpp` files

So, as a compile DB generator and automation layer, this still has reusable value.

---

### What Did Not Work

This is the main reason the project is archived.

#### Core goals not met

| Goal | Outcome |
|------|---------|
| **Rider-level UE C++ IntelliSense using clangd alone** | **Not achieved**. It stayed around Low–Medium fidelity. See [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md). |
| **clang error means bad code** | **False**. MSVC build could pass while clangd still reported errors. |
| **clangd as the only UE semantic engine** | **Out of scope for this archive**. Full UObject/reflection IDE behavior needs a different layer, like Rider, Visual Studio, or an official UE-aware LSP. |

#### `clangd --check` sampling

Same `compile_commands.json`, bundled clangd v6.1.1:

| Category | clangd | MSVC build |
|----------|--------|------------|
| Character module, some files | **0 errors** | OK |
| Graphics / actor module | `UStaticMesh::StaticClass()` error | OK |
| Combat / component module | `UCFS_FChecker`, `GetNameSafe` errors | OK |
| Controller module | `fatal_too_many_errors` | OK |
| Cinematic subsystem | `IsValid`, `GetComponents` errors | OK |
| Engine `Class.h` opened alone | `AutoRTFM/Defines.h` → `uint32` / `UClass` cascade | N/A |

The pattern was pretty clear:

- project-side `UCLASS::StaticClass()` sometimes worked;
- engine-side UObject types often failed;
- opening engine headers alone caused cascades that did not represent the actual game build.

In other words, the issue was not just “one missing include path.” It was the larger mismatch between **UHT + MSVC SharedPCH** and what generic clangd can approximate.

#### Structural limits

1. **Two different pipelines**  
   Real build: MSVC + UHT + SharedPCH  
   IDE: clangd + `compile_commands.json`

2. **No real UHT execution inside clangd**  
   `GENERATED_BODY`, `StaticClass()`, `TObjectPtr<>`, reflection metadata, and generated members cannot be fully understood by clangd alone.

3. **MSVC SharedPCH problem**  
   clang can consume parts of the forced PCH setup, but not in the same way Unreal’s real MSVC build does.

4. **Orphan engine headers**  
   Headers opened directly under `Program Files/Epic Games/...` do not always receive the project `.clangd` context.

5. **Diagnostic suppression is not understanding**  
   Hiding diagnostics makes Problems quieter. It does not make clangd more UE-aware.

6. **Blueprint graph support needs the editor**  
   Blueprint node-level data depends on MCP/editor-side access, not clangd.

7. **`.uasset` deep parse was not implemented**  
   The project mostly used headers and editor bridges, not full binary asset parsing.

#### Tried, but not enough

- UHT IDE stubs helped with macro recognition, but not generated bodies.
- reflection-index + CodeLens reached partial/medium usefulness, not Rider-level behavior.
- SharedPCH strip and fallback include experiments were started conceptually, but not measured at project scale before shutdown.

---

### Performance & Resource Notes

These are rough notes from the experiment, not formal benchmarks.

#### Design choices that helped

| Item | Notes |
|------|-------|
| **Zero-Touch bootstrap** | Generates `.vscode`, `.clangd`, and MCP config quickly, separate from full UBT build |
| **`.Shared.rsp` → compile_commands** | After one editor build, RSP parsing is relatively fast compared to rerunning UBT every time |
| **Background UHT warm-up** | `autoWarmUnrealCacheOnOpen` runs UBT Editor build without blocking extension activation |
| **cpptools disabled** | Avoids duplicate C++ indexing by keeping one clangd LSP stack |
| **Watcher debounce** | `.Shared.rsp` 5s, source changes 15s, reflection 5s |
| **Explorer filter** | Hides `Intermediate`, `Binaries`, and `Content` to reduce noise |

#### Expensive phases

| Phase | Typical feel | Cause |
|-------|--------------|-------|
| **First open + clangd indexing** | Minutes, RAM spike | `--background-index`, hundreds of `-I` entries per TU, `--pch-storage=memory` |
| **UBT Editor warm-up / first build** | Minutes to tens of minutes | UHT + module compile; needed before Ready IntelliSense |
| **`compile_commands.json` size** | Multi-MB possible | Long per-TU command lines |
| **clangd `--check` for one file** | ~10–20s+ | Large PCH force-include and UE include fan-out |
| **Bundled LLVM in VSIX** | ~150MB | clangd 19.1 shipped in release package |
| **`--clang-tidy` always on** | Extra CPU | Default generated clangd arguments |
| **`-j=12`** | High CPU usage | Parallel parse/index; can cause fan noise or throttling |

Generated clangd defaults:

```txt
--background-index
--clang-tidy
--pch-storage=memory
--limit-results=500
-j=12
```

Generated `.clangd` includes `Index: Background: Build`, `CompilationDatabase: .`, UHT stubs, and many `Intermediate` include paths.

#### Practical tuning hints

1. On lower-end machines, try `-j=4` instead of `-j=12`.
2. Consider removing `--clang-tidy` if indexing is too heavy.
3. Turning off `--background-index` can reduce load, but completion quality will drop.
4. `autoRefreshOnSourceChange: false` may help on large projects or teams with frequent saves.
5. Do one editor build first, then refresh IntelliSense. RSP-based Ready state is usually better than synthetic Partial state.
6. Avoid running multiple clangd instances on the same UE project unless you really need to.

---

### Conclusion

This project did **not** become a Rider replacement.

But it still leaves behind a few useful parts:

- Cursor-side AI/MCP/editor automation
- Content Browser and asset workflow experiments
- Blueprint bridge ideas
- compile_commands automation
- UE clangd failure cases and notes

For actual UE C++ work, the most realistic workflow is probably:

- **Rider or Visual Studio** for deep C++ navigation and build-aware Unreal semantics
- **Cursor** for AI, MCP, automation, project search, assets, and experimental tooling

For Problems panel noise, the rule of thumb is:

> Treat `msCompile` errors, especially severity 8, as real build failures.  
> Treat many `source: clang` errors on engine paths as IDE noise unless MSVC also fails.

---

### Notes for Anyone Continuing This

If you want to pick this up again, I would start here:

1. [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md)
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)
3. `src/cursor/bootstrapProject.ts`
4. `compileDatabaseFromRsp.ts`

Things I would not repeat blindly:

- Do not assume `compile_commands Ready` means clangd will fully understand Unreal.
- Do not keep adding suppress rules just to make Problems quiet.
- Do not assume one more clangd flag will suddenly make this Rider-level.

Things that still look worth trying:

| Direction | Why |
|-----------|-----|
| **MCP / assets / Content Browser** | Cursor + live editor integration is genuinely useful |
| **compile_commands automation** | Useful for clangd, CI, analyzers, and AI context |
| **reflection-index / CodeLens** | Better as a side layer next to clangd, not a full replacement |
| **SharedPCH strip experiment** | Strip MSVC PCH `-include`, then run full-module `clangd --check` before/after |
| **Official Epic UE-aware LSP** | If Epic ships one, plugging Cursor into that would be better than maintaining a fork |

If you restart the experiment, measure before/after properly:

1. Open a UE 5.8 `.uproject` root as the workspace.
2. Run `npm test`.
3. Run `clangd --check` across several modules.
4. Define success as something measurable, not “Problems panel is empty.”
5. Only treat `msCompile` as the actual build result.

PRs, issues, and forks are welcome. Measurable before/after results are much more useful than “I changed one clangd flag and it feels better.”

---

## 한국어

### 프로젝트 상태

**이 실험은 2026년 6월 기준으로 여기서 멈췄습니다.**

처음 목표는 간단했습니다.

> Cursor에서도 UE 5.8 C++ IntelliSense를 꽤 쓸만하게 만들 수 없을까?

그래서 clangd, `compile_commands.json`, UBT, UHT, SharedPCH, generated header, 모듈 include 경로를 계속 맞춰 봤습니다. 어느 정도 되는 부분도 있었지만, 최종적으로 **clangd만으로 Rider급 Unreal C++ 환경을 만드는 데는 실패**했습니다.

실제 UE 5.8 게임 프로젝트에서는 **MSVC 빌드와 에디터 실행은 정상**이었습니다. 문제는 Cursor/VS Code Problems 창에 `source: clang` 오류가 계속 남는 경우가 많았다는 점입니다.

이건 단순히 Cursor가 나쁘다거나 VS Code가 문제라는 얘기는 아닙니다. 더 정확히는 아래 두 구조의 차이에 가깝습니다.

- 실제 빌드: **MSVC + UBT + UHT + SharedPCH**
- IDE 분석: **clangd + compile_commands.json 근사치**

Cursor는 여전히 **AI, MCP, 자동화, 에셋, Blueprint 연동** 쪽에서 쓸만했습니다. 다만 UObject/리플렉션까지 깊게 이해하는 C++ IDE 경험을 원한다면, Rider나 Visual Studio를 같이 쓰는 쪽이 현실적입니다.

이 repo는 완성품이라기보다는 다음에 가깝습니다.

> 실험 기록, 실패 기록, 그리고 이어서 쓸 수 있는 부품함.

---

### 성공한 것들

#### 워크플로 · 자동화

| 항목 | 내용 |
|------|------|
| **Zero-Touch Bootstrap** | 프로젝트를 열 때 `.vscode/settings.json`, `.clangd`, `compile_commands.json`, `.cursor/mcp.json`, UHT IDE stubs 자동 생성 |
| **compile_commands 3단계 파이프라인** | `.Shared.rsp` 파싱 → UBT `GenerateClangDatabase` → `Build.cs` 기반 synthetic fallback |
| **IntelliSense 상태 표시** | Status bar에 `Ready`, `Partial`, `Missing` 표시 |
| **`.Shared.rsp` 감시** | 에디터 빌드 후 compile DB 자동 갱신 |
| **UE 5.8 전용 게이트** | `EngineAssociation` 5.8 확인, 레지스트리/경로 탐색 |
| **번들 clangd 19.1** | win32-x64 VSIX에 LLVM 포함, 별도 설치 불필요 |
| **C++ LSP 단일화** | cpptools IntelliSense를 끄고 clangd만 사용 |

#### 빌드 · 에디터

| 항목 | 내용 |
|------|------|
| **UBT 빌드 태스크** | Build / Rebuild / Clean |
| **에디터 실행** | Launch Unreal Editor, debug attach, PIE |
| **Live Coding** | Live Coding compile 명령 |
| **Class Wizard** | New C++ Class 템플릿 |

#### MCP · 에셋 · Blueprint

이 프로젝트에서 제일 가능성이 있었던 부분은 오히려 C++ IntelliSense보다 이쪽이었습니다.

| 항목 | 내용 |
|------|------|
| **UE Editor MCP 연동** | 포트 8000, `.cursor/mcp.json` 자동 구성, schema snapshot |
| **Epic MCP `call_tool` 브릿지** | 에디터 실행 중 MCP tool 호출 |
| **Content Browser** | Tree / Webview, 필터, 검색, Copy Path |
| **Asset index · 썸네일** | MCP online 상태에서 에셋 인덱스와 썸네일 사용 |
| **Asset ReferenceProvider** | `TEXT("/Game/...")` → Shift+F12 |
| **참조 그래프** | Find Asset References, 2-hop 참조 탐색 |
| **Blueprint 브릿지** | BP 열기, class에 대응되는 BP 찾기, C++로 이동 |
| **UHT reflection-index · CodeLens** | UFUNCTION 정보, BP usage 확인. 다만 부분적 |
| **CI / 테스트** | `npm test`, MCP schema ajv 검증, bootstrap/integration test |

#### compile_commands 품질

compile DB 자동화 자체는 의미가 있었습니다.

`.Shared.rsp` 기반으로 **Ready** 상태까지 도달했고, 다음 같은 UBT 플래그도 어느 정도 반영됐습니다.

- AutoRTFM
- Core / Engine UHT include path
- `Definitions.<Module>.h`
- SharedPCH `-include`
- 게임 primary module `.cpp` 파일들

즉, Rider 대체에는 실패했지만, **compile_commands 생성기나 자동화 코드**로는 재활용할 부분이 있습니다.

---

### 실패한 것들

여기가 이 repo의 핵심입니다.

#### 핵심 목표 미달성

| 목표 | 결과 |
|------|------|
| **clangd만으로 Rider급 UE C++ IntelliSense** | **미달성**. Low–Medium fidelity 수준에서 멈췄습니다. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) 참고. |
| **clang error = 코드 문제** | **성립하지 않음**. MSVC 빌드는 성공하는데 clangd 오류가 남는 경우가 많았습니다. |
| **clangd를 UE 의미 분석의 유일한 엔진으로 사용** | **이 아카이브 범위 밖**. full UObject/리플렉션 IDE는 Rider, Visual Studio, 또는 UE-aware LSP 같은 별도 계층이 필요합니다. |

#### `clangd --check` 샘플링

동일한 `compile_commands.json`, 번들 clangd v6.1.1 기준입니다.

| 유형 | clangd | MSVC 빌드 |
|------|--------|-----------|
| 캐릭터 모듈 일부 | **0 errors** | 정상 |
| 그래픽/액터 모듈 | `UStaticMesh::StaticClass()` error | 정상 |
| 전투/컴포넌트 모듈 | `UCFS_FChecker`, `GetNameSafe` errors | 정상 |
| 컨트롤러 모듈 | `fatal_too_many_errors` | 정상 |
| 시네마틱 서브시스템 | `IsValid`, `GetComponents` errors | 정상 |
| 엔진 `Class.h` 단독 열기 | `AutoRTFM/Defines.h` → `uint32` / `UClass` 연쇄 error | 게임 빌드와 직접 무관 |

패턴은 대충 이랬습니다.

- 프로젝트 쪽 `UCLASS::StaticClass()`는 통과하는 경우가 있음
- 엔진 쪽 UObject 타입은 자주 실패
- 엔진 헤더를 단독으로 열면 실제 게임 빌드와 무관한 연쇄 오류가 많이 발생

결국 “include path 하나 빠졌다” 수준의 문제가 아니었습니다. **UHT + MSVC SharedPCH + Unreal 빌드 구조**를 범용 clangd가 완전히 따라가기 어렵다는 쪽에 가까웠습니다.

#### 구조적 한계

1. **파이프라인이 둘로 갈라짐**  
   실제 빌드: MSVC + UHT + SharedPCH  
   IDE 분석: clangd + `compile_commands.json`

2. **clangd 안에서 UHT가 실제로 도는 게 아님**  
   `GENERATED_BODY`, `StaticClass()`, `TObjectPtr<>`, 리플렉션 메타데이터, generated member를 완전히 이해하기 어렵습니다.

3. **MSVC SharedPCH 문제**  
   clang이 강제 include된 SharedPCH를 어느 정도 읽더라도, Unreal의 실제 MSVC 빌드와 동일하게 처리하지는 못했습니다.

4. **엔진 헤더 단독 오픈 문제**  
   `Program Files/Epic Games/...` 아래 엔진 헤더를 직접 열면 프로젝트 `.clangd` 컨텍스트가 제대로 안 붙는 경우가 있었습니다.

5. **진단 suppress는 이해가 아님**  
   오류를 숨기면 Problems 창은 조용해집니다. 하지만 clangd가 UE를 더 잘 이해하게 되는 건 아닙니다.

6. **Blueprint 그래프는 에디터 의존**  
   C++ ↔ BP 노드 수준 탐색은 MCP/editor 쪽 정보가 필요합니다. clangd만으로는 안 됩니다.

7. **`.uasset` deep parse 미구현**  
   헤더와 에디터 브릿지 중심이었고, `.uasset` 바이너리를 깊게 파싱하는 구조는 구현하지 않았습니다.

#### 시도했지만 충분하지 않았던 것

- UHT IDE stubs: 매크로 인식에는 도움이 됐지만 generated body를 만들어주지는 못했습니다.
- reflection-index + CodeLens: 부분적으로 쓸만했지만 Rider급은 아니었습니다.
- SharedPCH 제거 / fallback include 실험: 아이디어는 있었지만, 프로젝트 전체 기준 before/after 측정까지는 못 갔습니다.

---

### 성능 · 리소스 메모

정식 벤치마크는 아니고, 실험 중 체감한 기록입니다. 프로젝트 크기와 PC 사양에 따라 차이가 큽니다.

#### 괜찮았던 설계

| 항목 | 내용 |
|------|------|
| **Zero-Touch bootstrap** | `.vscode`, `.clangd`, MCP 설정 생성은 빠른 편. UBT full build와 분리 |
| **`.Shared.rsp` → compile_commands** | 에디터 1회 빌드 후에는 RSP 파싱으로 DB 갱신 가능. 매번 UBT를 다시 돌리는 것보다 가벼움 |
| **백그라운드 UHT warm-up** | `autoWarmUnrealCacheOnOpen`으로 확장 활성화를 막지 않고 UBT Editor build 실행 |
| **cpptools 비활성화** | C++ 인덱싱을 clangd 하나로 줄여 중복 인덱싱 방지 |
| **watcher debounce** | `.Shared.rsp` 5초, 소스 변경 15초, reflection 5초 |
| **Explorer filter** | `Intermediate`, `Binaries`, `Content` 등을 숨겨 탐색기/감시 노이즈 감소 |

#### 무거웠던 구간

| 구간 | 체감 | 원인 |
|------|------|------|
| **첫 오픈 + clangd 인덱싱** | 수 분, RAM 상승 | `--background-index`, TU당 수백 개 `-I`, `--pch-storage=memory` |
| **UBT Editor warm-up / 첫 빌드** | 수 분~수십 분 | UHT + 모듈 컴파일. Ready IntelliSense 전제 |
| **`compile_commands.json` 크기** | 수 MB 가능 | TU마다 긴 command line |
| **clangd `--check` 1파일** | 약 10~20초 이상 | 대형 PCH force-include, UE include fan-out |
| **VSIX 번들 LLVM** | 약 150MB | clangd 19.1을 릴리즈 패키지에 포함 |
| **`--clang-tidy` 기본 on** | CPU 추가 사용 | 생성된 clangd args 기본값 |
| **`-j=12`** | CPU 사용량 큼 | 병렬 파싱/인덱싱. 저사양에서는 팬 소음이나 스로틀 발생 가능 |

기본 생성 clangd 옵션은 대략 이렇습니다.

```txt
--background-index
--clang-tidy
--pch-storage=memory
--limit-results=500
-j=12
```

생성되는 `.clangd`에는 `Index: Background: Build`, `CompilationDatabase: .`, UHT stubs, 여러 `Intermediate` include path가 들어갑니다.

#### 튜닝 힌트

1. 저사양 PC라면 `-j=12`를 `-j=4` 정도로 낮춰보는 게 낫습니다.
2. 너무 무거우면 `--clang-tidy` 제거를 먼저 고려해볼 만합니다.
3. `--background-index`를 끄면 가벼워질 수는 있지만 completion 품질도 떨어질 수 있습니다.
4. 대형 프로젝트나 팀 작업에서는 `autoRefreshOnSourceChange: false`가 나을 수 있습니다.
5. 에디터에서 한 번 빌드한 뒤 Refresh IntelliSense를 돌리는 편이 synthetic Partial 상태보다 낫습니다.
6. 같은 프로젝트에 clangd를 여러 개 띄우는 건 가능하면 피하는 편이 좋습니다.

---

### 결론

이 프로젝트는 **Rider 대체품이 되지는 못했습니다.**

그래도 남길 만한 건 있습니다.

- Cursor 쪽 AI/MCP/editor 자동화
- Content Browser / asset workflow 실험
- Blueprint bridge 아이디어
- compile_commands 자동 생성
- UE + clangd 실패 케이스 정리

현실적인 사용 방식은 이런 쪽에 가깝습니다.

- **Rider 또는 Visual Studio**: 깊은 C++ 탐색, 빌드 인식, Unreal semantics
- **Cursor**: AI, MCP, 자동화, 프로젝트 검색, 에셋/Blueprint 보조 도구

Problems 창은 이렇게 보는 게 낫습니다.

> `msCompile` 오류, 특히 severity 8은 실제 빌드 실패로 봐도 됩니다.  
> 반대로 엔진 경로에서 뜨는 `source: clang` 오류는 MSVC 빌드도 실패하는지 먼저 확인해야 합니다.

---

### 이어서 해볼 사람에게

이 실험을 다시 잡는다면, 먼저 이 파일들을 보는 걸 추천합니다.

1. [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md)
2. [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md)
3. `src/cursor/bootstrapProject.ts`
4. `compileDatabaseFromRsp.ts`

다시 반복하지 않았으면 하는 것들:

- `compile_commands`가 Ready라고 해서 clangd가 Unreal을 완전히 이해한다고 보면 안 됩니다.
- suppress만 늘려서 Problems 창을 조용하게 만드는 건 큰 의미가 없습니다.
- clangd 옵션 하나 더 넣으면 갑자기 Rider급이 될 거라는 기대는 빨리 한계가 옵니다.

그래도 해볼 만한 방향:

| 방향 | 이유 |
|------|------|
| **MCP / 에셋 / Content Browser** | Cursor + 실행 중인 에디터 연동은 확실히 쓸모가 있습니다 |
| **compile_commands 자동화** | clangd뿐 아니라 CI, 분석기, AI 컨텍스트에도 재활용 가능 |
| **reflection-index / CodeLens** | clangd를 대체하기보다 옆에서 UE 의미 정보를 보완하는 쪽이 현실적 |
| **SharedPCH 제거 실험** | `compileDatabaseFromRsp.ts`에서 PCH strip 후 전 모듈 `clangd --check` before/after 측정 |
| **Epic 공식 UE-aware LSP** | 만약 나온다면 fork보다 Cursor 어댑터를 붙이는 쪽이 낫습니다 |

다시 시작한다면 최소한 이것만은 했으면 합니다.

1. UE 5.8 게임 `.uproject` 루트를 workspace로 열기
2. `npm test` 실행
3. 여러 모듈에 대해 `clangd --check` 실행
4. “Problems 0개” 같은 목표 말고, 측정 가능한 성공 기준 정하기
5. 실제 빌드 실패 여부는 `msCompile` 기준으로 판단하기

PR, issue, fork는 환영합니다.  
다만 “clangd 옵션 한 줄 바꿨더니 느낌상 좋아졌다”보다는, before/after 숫자가 있는 쪽이 훨씬 도움이 됩니다.

---

## References · 참고

| Document | Description |
|----------|-------------|
| [docs/ue-clangd-error-analysis.en.md](docs/ue-clangd-error-analysis.en.md) | clangd vs MSVC build analysis, English |
| [docs/ue-clangd-error-analysis.ko.md](docs/ue-clangd-error-analysis.ko.md) | clangd vs MSVC 빌드 분석, 한국어 |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [docs/uobject-lsp-research.md](docs/uobject-lsp-research.md) | UObject / clangd vs Rider research |

---

## Archive: build extension · 레거시 빌드

실험은 멈췄지만, 확장 자체는 참고용으로 빌드할 수 있습니다.

```bash
npm install
npm run build
npm test
npm run package   # fetch-llvm + win32-x64 VSIX
```

설치 후에는 다음 명령 정도를 사용할 수 있습니다.

- **Setup UE 5.8 Project**
- **Refresh IntelliSense**
- **Launch Unreal Editor**
- **Verify MCP Connection**

자주 건드릴 설정:

- `ue58rider.autoSetupOnOpen`
- `ue58rider.engineRoot`
- `ue58rider.llvmPath` — 비워두면 번들 clangd 사용
