import * as vscode from 'vscode';
import { findClangdPath } from '../detection/prerequisites';
import { discoverEngines } from '../detection/engineDiscovery';
import type { UE5_8CursorSettings } from '../config/settings';

export async function showWelcomePanel(settings: UE5_8CursorSettings): Promise<void> {
  const clangd = await findClangdPath(settings.llvmPath);
  const engines = await discoverEngines();

  const items: vscode.QuickPickItem[] = [
    {
      label: clangd ? '$(check) LLVM / clangd' : '$(x) LLVM / clangd',
      description: clangd ?? '미설치 — LLVM 20.1.8 필요',
    },
    {
      label: engines.length > 0 ? '$(check) UE 5.8 Engine' : '$(x) UE 5.8 Engine',
      description: engines.length > 0 ? `${engines.length}개 발견` : 'Epic Launcher에서 설치',
    },
    {
      label: '$(check) C/C++ for Cursor',
      description: '확장 팩에 포함 (anysphere.cpptools)',
    },
    {
      label: '$(info) MCP AllToolsets · 포트 8000',
      description: 'ModelContextProtocol + AllToolsets 플러그인 활성화',
    },
    {
      label: '$(arrow-right) Setup UE 5.8 Project',
      description: 'IntelliSense + Debug + MCP 전체 설정',
    },
    {
      label: '$(arrow-right) Open Multi-Root Workspace',
      description: 'Source + Plugins 멀티 루트 .code-workspace',
    },
    {
      label: '$(arrow-right) Verify MCP Connection',
      description: 'UE 5.8 에디터 MCP 연결 확인',
    },
    {
      label: '$(arrow-right) Refresh MCP Schema',
      description: 'describe_toolset 스냅샷 + resolved tools',
    },
    {
      label: '$(arrow-right) Show Content Browser',
      description: '에셋 트리 · 검색 · Shift+F12 참조',
    },
    {
      label: '$(arrow-right) Show MCP Diagnostics',
      description: '포트, toolset, resolved logical tools',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'UE5_8 Cursor v5 시작 가이드',
    title: 'UE5_8 Cursor Welcome',
  });

  if (!picked) return;
  if (picked.label.includes('Setup UE')) {
    await vscode.commands.executeCommand('ue58rider.setupProject');
  } else if (picked.label.includes('Multi-Root')) {
    await vscode.commands.executeCommand('ue58rider.openMultiRootWorkspace');
  } else if (picked.label.includes('Verify MCP')) {
    await vscode.commands.executeCommand('ue58rider.verifyMcp');
  } else if (picked.label.includes('Refresh MCP')) {
    await vscode.commands.executeCommand('ue58rider.refreshMcpSchema');
  } else if (picked.label.includes('Content Browser')) {
    await vscode.commands.executeCommand('ue58rider.showContentBrowser');
  } else if (picked.label.includes('MCP Diagnostics')) {
    await vscode.commands.executeCommand('ue58rider.showMcpDiagnostics');
  }
}
