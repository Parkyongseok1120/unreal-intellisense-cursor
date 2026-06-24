import fs from 'node:fs';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

pkg.version = '3.2.0';
pkg.description =
  'Cursor dedicated Unreal Engine 5.8 C++ workflow — IntelliSense, build, Live Coding, MCP';

const desc = {
  'ue58rider.engineRoot': 'UE 5.8 엔진 루트 경로. 비워두면 자동 탐지.',
  'ue58rider.projectFile': '.uproject 파일 경로. 비워두면 자동 탐지.',
  'ue58rider.buildConfiguration': '기본 빌드 구성.',
  'ue58rider.buildTarget': '기본 빌드 타겟.',
  'ue58rider.platform': '타겟 플랫폼.',
  'ue58rider.llvmPath': 'clangd 실행 파일 경로. 비워두면 PATH에서 탐색.',
  'ue58rider.autoSetupOnOpen': '프로젝트 열 때 IntelliSense 전체 설정 프롬프트.',
  'ue58rider.autoGenerateCompileCommands': 'compile_commands.json이 없으면 자동 생성.',
  'ue58rider.upsertClangdConfig': 'UE 최적화 .clangd 설정 적용.',
  'ue58rider.liveCoding.method': 'Live Coding 트리거 방식.',
  'ue58rider.hideExplorerNoise': 'Explorer에서 Source/Plugins/Config 외 캐시 폴더 숨김.',
  'ue58rider.debug.buildConfiguration': '디버깅용 빌드 구성. DebugGame 권장.',
  'ue58rider.debug.autoBuildBeforeLaunch': '디버그 시작 전 자동 빌드.',
  'ue58rider.autoRefreshOnSourceChange': '새 모듈/소스 추가 시 compile_commands 자동 갱신.',
  'ue58rider.mcp.enabled': 'UE 5.8 MCP .cursor/mcp.json 자동 설정.',
  'ue58rider.mcp.port': 'UE MCP 포트 (0=자동 탐색).',
  'ue58rider.mcp.portDefault': 'UE MCP 기본 포트.',
  'ue58rider.autoStartLogViewer': '에디터 실행 시 로그 뷰어 자동 시작.',
  'ue58rider.showWelcomeOnFirstOpen': '첫 실행 시 Welcome 가이드 표시.',
};

for (const [key, value] of Object.entries(desc)) {
  if (pkg.contributes.configuration.properties[key]) {
    pkg.contributes.configuration.properties[key].description = value;
  }
}

const cmd = {
  command: 'ue58rider.findUFunctionBlueprints',
  title: 'Find UFUNCTION Blueprint Usages',
  category: 'UE5_8 Cursor',
};
if (!pkg.contributes.commands.find((c) => c.command === cmd.command)) {
  pkg.contributes.commands.push(cmd);
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('package.json fixed');
