import * as vscode from 'vscode';
import {
  generateClassFiles,
  suggestApiMacro,
  type WizardClassKind,
} from '../wizard/classWizard';
import { generateProjectFilesCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { formatCommandLine } from '../build/ubt';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

const CLASS_KINDS: Array<{ label: string; description: string; classKind: WizardClassKind }> = [
  { label: 'Actor', description: 'AActor — 월드에 배치', classKind: 'Actor' },
  { label: 'Character', description: 'ACharacter — 캐릭터', classKind: 'Character' },
  { label: 'Player Controller', description: 'APlayerController', classKind: 'PlayerController' },
  { label: 'Game Mode', description: 'AGameModeBase', classKind: 'GameMode' },
  { label: 'Actor Component', description: 'UActorComponent', classKind: 'ActorComponent' },
  { label: 'Game Instance', description: 'UGameInstance', classKind: 'GameInstance' },
  { label: 'Anim Instance', description: 'UAnimInstance', classKind: 'AnimInstance' },
  { label: 'UObject', description: '데이터/유틸', classKind: 'Object' },
  { label: 'Data Asset', description: 'UPrimaryDataAsset', classKind: 'DataAsset' },
  { label: 'User Widget', description: 'UUserWidget — UMG', classKind: 'UserWidget' },
  { label: 'Interface', description: 'UINTERFACE (헤더만)', classKind: 'Interface' },
];

export async function runClassWizard(ctx: UE5_8CursorContext, _settings: UE5_8CursorSettings): Promise<void> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트가 없습니다.');
    return;
  }

  const modules = ctx.project.modules.map((m) => m.name);
  const moduleName =
    modules.length === 1
      ? modules[0]
      : await vscode.window.showQuickPick(modules, { placeHolder: '모듈 선택' });
  if (!moduleName) return;

  const kind = await vscode.window.showQuickPick(CLASS_KINDS, { placeHolder: '클래스 종류' });
  if (!kind) return;

  const className = await vscode.window.showInputBox({
    prompt: '클래스 이름 (접두사 A/U/I 자동 추가)',
    placeHolder: 'MyNewCharacter',
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : '유효한 C++ 식별자를 입력하세요'),
  });
  if (!className) return;

  const subfolder = await vscode.window.showInputBox({
    prompt: '하위 폴더 (선택, e.g. Character/Enemy)',
    placeHolder: '비워두면 Public/Private 루트',
  });

  try {
    const result = await generateClassFiles(ctx.project, {
      className,
      kind: kind.classKind,
      moduleName,
      apiMacro: suggestApiMacro(moduleName),
      subfolder: subfolder || undefined,
    });

    const doc = await vscode.workspace.openTextDocument(result.headerPath);
    await vscode.window.showTextDocument(doc);

    if (ctx.engine) {
      const cmd = generateProjectFilesCommandLine(ctx.engine, ctx.project);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${formatCommandLine(cmd)}`);
      const pf = await spawnAsync(cmd.executable, cmd.args, {
        onStdout: (l) => ctx.outputChannel.appendLine(l),
        onStderr: (l) => ctx.outputChannel.appendLine(l),
      });
      if (pf.exitCode !== 0) {
        vscode.window.showWarningMessage('UE5_8 Cursor: GenerateProjectFiles 실패 — 수동으로 프로젝트 파일을 갱신하세요.');
      }
    }

    vscode.window.showInformationMessage(
      `UE5_8 Cursor: ${result.className} 생성 완료`,
      'IntelliSense 갱신',
    ).then((c) => {
      if (c === 'IntelliSense 갱신') {
        vscode.commands.executeCommand('ue58rider.generateCompileCommands');
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`UE5_8 Cursor: 클래스 생성 실패 — ${err}`);
  }
}
