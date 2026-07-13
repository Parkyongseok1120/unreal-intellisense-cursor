# UE5_8 Cursor v8.0.0 Beta

Unreal Engine 5.8 전용 Cursor 확장 베타 릴리즈입니다.

## Highlights

- 라이프사이클·데이터 보호·CI 안정화 중심 릴리즈
- 품질 점수 88% (10개 영역 가중 평균)
- 테스트 388 pass / 0 fail / 1 skip
- VSIX: `ue5-8-cursor-win32-x64-8.0.0.vsix` (~180 MB, win32-x64)

## 설치

**요구 사항:** Windows 10/11, Cursor/VS Code 1.85+, UE 5.8

    code --install-extension ue5-8-cursor-win32-x64-8.0.0.vsix

Bridge 플러그인: 명령 팔레트 → `UE5_8 Cursor: Install Cursor Bridge Plugin`

## Changes

### 안정화

- WorkspaceMutation: 동시 트랜잭션 차단, committing 저널 복구, rollback-conflict 저널 보존
- Bridge lifecycle: setup single-flight, reconnect debounce, dispose 시 RPC abort
- Asset index: per-project lock, authoritative sync, 원자적 캐시 저장
- CommandBridge: dispose 중 포트 누수·요청 차단
- UTF-8 프로세스 출력, Test Explorer 프로젝트 전환 race 수정

### CI

- Windows `npm test` glob 수정 (`scripts/run-tests.mjs`)
- Extension host hang 수정 (~7분 → ~30초)

## Known Limitations

- Rider/VS 대체 아님
- clangd 진단 ≠ MSVC 빌드 결과
- Full release gate는 self-hosted UE E2E 필요
- win32-x64 전용

## Links

https://github.com/Parkyongseok1120/unreal-intellisense-cursor
