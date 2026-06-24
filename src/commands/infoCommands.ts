import * as vscode from 'vscode';
import { checkPrerequisites } from '../detection/prerequisites';
import { natvisExists } from '../platform/debug';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';

export async function showProjectInfo(ctx: UE5_8CursorContext, settings: UE5_8CursorSettings): Promise<void> {
  const lines: string[] = ['=== UE5_8 Cursor Project Info ==='];

  if (ctx.project) {
    lines.push(`Project: ${ctx.project.name}`);
    lines.push(`Root: ${ctx.project.projectRoot}`);
    lines.push(`Engine Association: ${ctx.project.engineAssociation}`);
    lines.push(`Modules: ${ctx.project.modules.map((m) => m.name).join(', ')}`);
  } else {
    lines.push('Project: (not detected)');
  }

  if (ctx.engine) {
    lines.push(`Engine: UE ${ctx.engine.version}`);
    lines.push(`Engine Root: ${ctx.engine.root}`);
    lines.push(`UBT: ${ctx.engine.ubtPath}`);
    const hasNatvis = await natvisExists(ctx.engine.root);
    lines.push(`Unreal.natvis: ${hasNatvis ? 'found' : 'MISSING'}`);
  } else {
    lines.push('Engine: (not detected)');
  }

  lines.push(`Build Config: ${settings.buildConfiguration}`);
  lines.push(`Debug Build Config: ${settings.debugBuildConfiguration}`);
  lines.push(`Build Target: ${settings.buildTarget}`);
  lines.push(`Platform: ${settings.platform}`);

  ctx.outputChannel.clear();
  ctx.outputChannel.appendLine(lines.join('\n'));
  ctx.outputChannel.show(true);
}

export async function runPrerequisiteCheck(settings: UE5_8CursorSettings): Promise<void> {
  const checks = await checkPrerequisites(settings.llvmPath);
  const lines = checks.map((c) => {
    const status = c.ok ? '✓' : '✗';
    let line = `${status} ${c.name}: ${c.detail}`;
    if (!c.ok && c.fixHint) line += `\n    → ${c.fixHint}`;
    return line;
  });

  const allOk = checks.every((c) => c.ok);
  const message = lines.join('\n');

  if (allOk) {
    vscode.window.showInformationMessage('UE5_8 Cursor: 모든 사전 요구사항 충족!');
  } else {
    vscode.window.showWarningMessage('UE5_8 Cursor: 일부 사전 요구사항 미충족', '상세 보기').then((c) => {
      if (c === '상세 보기') {
        vscode.window.showInformationMessage(message, { modal: true });
      }
    });
  }
}
