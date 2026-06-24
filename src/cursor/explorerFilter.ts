/**
 * UE 프로젝트 Explorer 정리 — Source, Plugins, Config, *.uproject 만 보이도록
 * Content Browser 전용 뷰 사용 시 Content는 Explorer에서 계속 숨김.
 */

export const EXPLORER_FILTER_FLAG = 'ue58rider.explorerFilterApplied';

export type ContentBrowserMode = 'hidden' | 'dedicated-view' | 'explorer-visible';

/** files.exclude — Explorer에서 숨길 항목 */
export function getFilesExclude(contentBrowserMode: ContentBrowserMode = 'dedicated-view'): Record<string, boolean> {
  const hideContent = contentBrowserMode !== 'explorer-visible';

  return {
    // ── 프로젝트 루트 캐시/빌드 ──
    Binaries: true,
    Intermediate: true,
    DerivedDataCache: true,
    Saved: true,
    Content: hideContent,
    Build: true,
    Docs: true,

    // ── 어디서든 나타나는 UE 캐시 ──
    '**/.vs': true,
    '**/.idea': true,
    '**/Binaries': true,
    '**/Intermediate': true,
    '**/DerivedDataCache': true,
    '**/Saved': true,
    '**/enc_temp_folder': true,
    '**/obj': true,

    // ── 플러그인/문서 노이즈 ──
    '**/Docs': true,

    // ── VS/빌드 산출물 ──
    '*.sln': true,
    '*.suo': true,
    '*.opensdf': true,
    '*.sdf': true,
    '*.VC.db': true,
    '*.VC.opendb': true,
    '*.DotSettings*': true,

    // ── IDE 생성물 (플러그인이 자동 생성, Explorer에서 숨김) ──
    '.vscode': true,
    '.cursor': true,

    // ── IntelliSense 메타 (플러그인이 자동 생성) ──
    'compile_commands.json': true,
    '.clangd': true,
    '.clang-format': true,
    '.ue5_8cursor': true,
    '.ue58rider': true,
  };
}

/** search.exclude — 검색에서 제외 (성능) */
export function getSearchExclude(contentBrowserMode: ContentBrowserMode = 'dedicated-view'): Record<string, boolean> {
  const excludeContent = contentBrowserMode === 'hidden' || contentBrowserMode === 'dedicated-view';

  return {
    '**/Binaries': true,
    '**/Intermediate': true,
    '**/DerivedDataCache': true,
    '**/Saved': true,
    '**/Content': excludeContent,
    '**/Build': true,
    '**/Docs': true,
    '**/*.uasset': excludeContent,
    '**/*.umap': excludeContent,
    '**/*.ubulk': true,
    '**/*.uexp': true,
    '**/*.dll': true,
    '**/*.pdb': true,
    '**/*.exe': true,
  };
}

/** files.watcherExclude — 파일 감시 제외 (CPU 절약) */
export function getWatcherExclude(contentBrowserMode: ContentBrowserMode = 'dedicated-view'): Record<string, boolean> {
  const excludeContent = contentBrowserMode !== 'explorer-visible';

  return {
    '**/Binaries/**': true,
    '**/Intermediate/**': true,
    '**/DerivedDataCache/**': true,
    '**/Saved/**': true,
    '**/Content/**': excludeContent,
    '**/.git/objects/**': true,
    '**/.git/subtree-cache/**': true,
  };
}

export function getExplorerFilterSettings(contentBrowserMode: ContentBrowserMode = 'dedicated-view'): Record<string, unknown> {
  return {
    [EXPLORER_FILTER_FLAG]: true,
    'files.exclude': getFilesExclude(contentBrowserMode),
    'search.exclude': getSearchExclude(contentBrowserMode),
    'files.watcherExclude': getWatcherExclude(contentBrowserMode),
  };
}

/** 마커 키 제거 후 실제 설정만 반환 */
export function stripExplorerFilterMarkers(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings };
  delete result[EXPLORER_FILTER_FLAG];
  return result;
}

export function isExplorerFilterApplied(settings: Record<string, unknown>): boolean {
  return settings[EXPLORER_FILTER_FLAG] === true;
}
