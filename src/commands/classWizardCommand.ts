import * as vscode from 'vscode';
import {
  generateClassFiles,
  getMissingWizardDependencies,
  previewBuildCsPatch,
  readBuildCsContent,
  suggestApiMacro,
  type WizardClassKind,
} from '../wizard/classWizard';
import { generateProjectFilesCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { formatCommandLine } from '../build/ubt';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

const CLASS_KINDS: Array<{ label: string; description: string; classKind: WizardClassKind }> = [
  { label: 'Actor', description: 'AActor — world placeable', classKind: 'Actor' },
  { label: 'Character', description: 'ACharacter', classKind: 'Character' },
  { label: 'Player Controller', description: 'APlayerController', classKind: 'PlayerController' },
  { label: 'Game Mode', description: 'AGameModeBase', classKind: 'GameMode' },
  { label: 'Actor Component', description: 'UActorComponent', classKind: 'ActorComponent' },
  { label: 'Game Instance', description: 'UGameInstance', classKind: 'GameInstance' },
  { label: 'Anim Instance', description: 'UAnimInstance', classKind: 'AnimInstance' },
  { label: 'UObject', description: 'Data/utility', classKind: 'Object' },
  { label: 'Data Asset', description: 'UPrimaryDataAsset', classKind: 'DataAsset' },
  { label: 'User Widget', description: 'UUserWidget — requires UMG in Build.cs', classKind: 'UserWidget' },
  { label: 'Interface', description: 'UINTERFACE (header only)', classKind: 'Interface' },
];

export async function runClassWizard(ctx: UE5_8CursorContext, _settings: UE5_8CursorSettings): Promise<void> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: no project detected.');
    return;
  }

  const modules = ctx.project.modules.map((m) => m.name);
  const moduleName =
    modules.length === 1
      ? modules[0]
      : await vscode.window.showQuickPick(modules, { placeHolder: 'Select module' });
  if (!moduleName) return;

  const kind = await vscode.window.showQuickPick(CLASS_KINDS, { placeHolder: 'Class kind' });
  if (!kind) return;

  const className = await vscode.window.showInputBox({
    prompt: 'Class name (A/U/I prefix added automatically)',
    placeHolder: 'MyNewCharacter',
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : 'Enter a valid C++ identifier'),
  });
  if (!className) return;

  const subfolder = await vscode.window.showInputBox({
    prompt: 'Subfolder (optional, e.g. Character/Enemy)',
    placeHolder: 'Leave empty for Public/Private root',
  });

  const wizardInput = {
    className,
    kind: kind.classKind,
    moduleName,
    apiMacro: suggestApiMacro(moduleName),
    subfolder: subfolder || undefined,
    consentBuildCs: false,
  };

  const missingDeps = await getMissingWizardDependencies(ctx.project, wizardInput);
  if (missingDeps.length > 0) {
    const content = await readBuildCsContent(ctx.project, moduleName);
    const preview = content ? previewBuildCsPatch(content, missingDeps) : undefined;
    const detail = preview?.preview ?? missingDeps.map((d) => `+ "${d}"`).join('\n');
    const consent = await vscode.window.showWarningMessage(
      `${moduleName}.Build.cs needs module dependencies for ${kind.label}:`,
      { modal: true, detail },
      'Update Build.cs',
      'Cancel',
    );
    if (consent !== 'Update Build.cs') {
      vscode.window.showInformationMessage('Class creation cancelled — add dependencies manually to Build.cs first.');
      return;
    }
    wizardInput.consentBuildCs = true;
  }

  try {
    const result = await generateClassFiles(ctx.project, wizardInput);

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
        vscode.window.showWarningMessage('UE5_8 Cursor: GenerateProjectFiles failed — refresh project files manually.');
      }
    }

    vscode.window.showInformationMessage(`UE5_8 Cursor: created ${result.className}`, 'Refresh IntelliSense').then((c) => {
      if (c === 'Refresh IntelliSense') {
        vscode.commands.executeCommand('ue58rider.generateCompileCommands');
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`UE5_8 Cursor: class creation failed — ${err}`);
  }
}
