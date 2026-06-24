# UE5_8 Cursor

Cursor 전용 Unreal Engine 5.8 C++ 워크플로우 확장 (**v6.0 — Zero-Touch**).

## 3단계 시작 (Rider급)

1. **VSIX 설치** — `ue5-8-cursor-6.0.0.vsix` (clangd 19.1 + extension pack 포함)
2. **프로젝트 폴더 또는 `.uproject` 열기** — 확인 대화상자 없이 자동 부트스트랩
3. **코딩** — status bar `IntelliSense: Ready` 확인 후 C++ 편집

자동 생성 항목: `.vscode/settings.json`, `.clangd`, `compile_commands.json`, `.cursor/mcp.json`, UHT stubs.

### `.uproject`로 열기

탐색기에서 `MyGame.uproject` 더블클릭 또는 우클릭 → **Open UE Project in Cursor** → 프로젝트 루트 폴더로 workspace 전환.

## v6.0 신기능

- **Zero-Touch Bootstrap** — 엔진 미감지 시에도 `.clangd` / `.vscode` 생성
- **번들 clangd 19.1** — LLVM 별도 설치 없이 IntelliSense 즉시 동작 (win32-x64)
- **compile_commands 파이프라인** — `.Shared.rsp` → UBT → Build.cs synthetic 폴백
- **Silent 자동화** — 프롬프트 제거, status bar `IntelliSense: Ready | Partial | Missing`
- **`.Shared.rsp` 감시** — 에디터 빌드 후 compile_commands 자동 재생성

## MCP 설정 (에디터 실행 시)

1. `.uproject`에 플러그인 활성화: `ModelContextProtocol`, `AllToolsets`
2. 에디터: Edit → Editor Preferences → **Model Context Protocol** → Auto Start Server (포트 **8000**)
3. 확장 명령: **Refresh MCP Schema Snapshot** (에디터 실행 중)

## Status bar

| 항목 | 의미 |
|------|------|
| `IntelliSense: Ready` | compile_commands + clangd 준비 완료 |
| `IntelliSense: Partial` | Build.cs synthetic — 에디터 1회 빌드 권장 |
| `IntelliSense: Missing` | Setup 또는 Refresh IntelliSense |
| `MCP:8000` | UE MCP 연결 상태 |

## 주요 명령

- `UE5_8 Cursor: Setup UE 5.8 Project` — 수동 전체 부트스트랩
- `UE5_8 Cursor: Refresh IntelliSense (compile_commands.json)`
- `UE5_8 Cursor: Open UE Project in Cursor`
- `UE5_8 Cursor: Launch Unreal Editor`

## 빌드 / 패키징

```bash
npm install
npm run build
npm test
npm run package   # fetch-llvm + win32-x64 VSIX
```

## 설정 요약

- `ue58rider.autoSetupOnOpen`: `true` — 폴더 열 때 자동 부트스트랩
- `ue58rider.autoSetupSilent`: `true` — 확인 대화상자 없음
- `ue58rider.engineRoot`: UE 5.8 경로 (비우면 자동 탐지)
- `ue58rider.llvmPath`: 비우면 VSIX 번들 clangd 사용

## 한계

| 영역 | 한계 |
|------|------|
| UE 엔진 | VSIX에 포함 불가 — 자동 감지 또는 `engineRoot` 설정 |
| 완전 UHT | 에디터 미빌드 시 synthetic/partial IntelliSense만 |
| MSVC 빌드 | Visual Studio Build Tools 별도 필요 |

자세한 변경 이력은 [CHANGELOG.md](CHANGELOG.md) 참고.
