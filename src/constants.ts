export const EXTENSION_ID = 'ue58rider';

/** 사용자에게 보이는 확장 이름 */
export const EXTENSION_DISPLAY_NAME = 'UE5_8 Cursor';

export const SUPPORTED_ENGINE_VERSION = '5.8';

/** UE 5.8 권장 LLVM 버전 (Epic Platform SDK Upgrades 기준, 5.7과 동일 계열) */
export const RECOMMENDED_LLVM_VERSION = '19.1.0';

export const Commands = {
  OpenUproject: `${EXTENSION_ID}.openUproject`,
  SetupProject: `${EXTENSION_ID}.setupProject`,
  Build: `${EXTENSION_ID}.build`,
  Rebuild: `${EXTENSION_ID}.rebuild`,
  Clean: `${EXTENSION_ID}.clean`,
  LaunchEditor: `${EXTENSION_ID}.launchEditor`,
  LiveCoding: `${EXTENSION_ID}.liveCoding`,
  GenerateCompileCommands: `${EXTENSION_ID}.generateCompileCommands`,
  SwitchHeaderSource: `${EXTENSION_ID}.switchHeaderSource`,
  SelectEngine: `${EXTENSION_ID}.selectEngine`,
  SelectProject: `${EXTENSION_ID}.selectProject`,
  SelectBuildConfig: `${EXTENSION_ID}.selectBuildConfig`,
  ShowProjectInfo: `${EXTENSION_ID}.showProjectInfo`,
  CheckPrerequisites: `${EXTENSION_ID}.checkPrerequisites`,
  ApplyExplorerFilter: `${EXTENSION_ID}.applyExplorerFilter`,
  ResetExplorerFilter: `${EXTENSION_ID}.resetExplorerFilter`,
  DebugLaunchEditor: `${EXTENSION_ID}.debugLaunchEditor`,
  DebugAttachEditor: `${EXTENSION_ID}.debugAttachEditor`,
  DebugLaunchGame: `${EXTENSION_ID}.debugLaunchGame`,
  DebugPIE: `${EXTENSION_ID}.debugPIE`,
  NewCppClass: `${EXTENSION_ID}.newCppClass`,
  OpenBlueprint: `${EXTENSION_ID}.openBlueprint`,
  FindBlueprints: `${EXTENSION_ID}.findBlueprints`,
  CreateBlueprintSubclass: `${EXTENSION_ID}.createBlueprintSubclass`,
  JumpToCppFromBlueprint: `${EXTENSION_ID}.jumpToCppFromBlueprint`,
  SetupMcp: `${EXTENSION_ID}.setupMcp`,
  VerifyMcp: `${EXTENSION_ID}.verifyMcp`,
  RefreshUhtIntellisense: `${EXTENSION_ID}.refreshUhtIntellisense`,
  StartLogViewer: `${EXTENSION_ID}.startLogViewer`,
  StopLogViewer: `${EXTENSION_ID}.stopLogViewer`,
  ShowWelcome: `${EXTENSION_ID}.showWelcome`,
  OpenMultiRootWorkspace: `${EXTENSION_ID}.openMultiRootWorkspace`,
  ShowUFunctionInfo: `${EXTENSION_ID}.showUFunctionInfo`,
  FindUFunctionBlueprints: `${EXTENSION_ID}.findUFunctionBlueprints`,
  RefreshMcpSchema: `${EXTENSION_ID}.refreshMcpSchema`,
  RefreshAssetIndex: `${EXTENSION_ID}.refreshAssetIndex`,
  OpenAsset: `${EXTENSION_ID}.openAsset`,
  FindAssetReferences: `${EXTENSION_ID}.findAssetReferences`,
  ShowContentBrowser: `${EXTENSION_ID}.showContentBrowser`,
  ShowMcpDiagnostics: `${EXTENSION_ID}.showMcpDiagnostics`,
  FilterContentBrowser: `${EXTENSION_ID}.filterContentBrowser`,
  SearchAssets: `${EXTENSION_ID}.searchAssets`,
  CopyAssetPath: `${EXTENSION_ID}.copyAssetPath`,
  ShowContentWebview: `${EXTENSION_ID}.showContentWebview`,
} as const;

export const ContextKeys = {
  ProjectDetected: `${EXTENSION_ID}.projectDetected`,
  EngineFound: `${EXTENSION_ID}.engineFound`,
  BuildToolsFound: `${EXTENSION_ID}.buildToolsFound`,
} as const;

export const Registry = {
  LauncherInstalls: 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine',
  SourceBuilds: 'HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds',
} as const;

export const COMMON_ENGINE_PATHS = [
  'C:\\Program Files\\Epic Games',
  'D:\\Program Files\\Epic Games',
  'C:\\Epic Games',
  'D:\\Epic Games',
  'E:\\Epic Games',
] as const;

export const TARGET_SUFFIXES: Record<string, string> = {
  Editor: 'Editor',
  Game: '',
  Client: 'Client',
  Server: 'Server',
};

/** 플러그인 생성 데이터 디렉터리 (레거시 .ue58rider 호환) */
export const EXTENSION_DATA_DIR = '.ue5_8cursor';
export const EXTENSION_DATA_DIR_LEGACY = '.ue58rider';

export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';

export const CLANGD_MANAGED_BEGIN = '# <<< ue5_8cursor-managed >>>';
export const CLANGD_MANAGED_END = '# <<< end-ue5_8cursor-managed >>>';
/** @deprecated use CLANGD_MANAGED_BEGIN */
export const LEGACY_CLANGD_MANAGED_BEGIN = '# <<< ue58rider-managed >>>';
export const LEGACY_CLANGD_MANAGED_END = '# <<< end-ue58rider-managed >>>';
