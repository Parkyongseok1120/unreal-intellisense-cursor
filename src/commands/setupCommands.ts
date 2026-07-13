import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import { ensureUhtIntellisense } from '../cursor/projectSetup';
import type { BootstrapResult, IntelliSenseMode } from '../cursor/bootstrapProject';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import { requestClangdRestart } from '../cursor/clangdLifecycle';

export async function setupProject(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath?: string,
): Promise<BootstrapResult | undefined> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트가 감지되지 않았습니다.');
    return undefined;
  }

  let result: BootstrapResult | undefined;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'UE5_8 Cursor: 프로젝트 설정 중...',
      cancellable: false,
    },
    async () => {
      if (!extensionPath) return;
      const { bootstrapProject } = await import('../cursor/bootstrapProject');
      result = await bootstrapProject(ctx, settings, extensionPath);
      if (result.intelliSense === 'ready') {
        vscode.window.showInformationMessage('UE5_8 Cursor: IntelliSense 준비 완료.');
      } else if (result.intelliSense === 'partial') {
        vscode.window.showInformationMessage(
          'UE5_8 Cursor: IntelliSense 부분 준비 — 에디터에서 한 번 빌드하면 정확도가 올라갑니다.',
        );
      } else {
        vscode.window.showWarningMessage('UE5_8 Cursor: IntelliSense 설정이 완료되지 않았습니다. Output 로그를 확인하세요.');
      }
    },
  );
  return result;
}

export async function generateCompileCommands(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath?: string,
): Promise<IntelliSenseMode> {
  if (!ctx.project) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트가 없습니다.');
    return 'missing';
  }

  let mode: IntelliSenseMode = 'missing';
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'UE5_8 Cursor: compile_commands.json 생성 중...',
      cancellable: false,
    },
    async () => {
      ctx.outputChannel.show(true);
      const { ensureCompileDatabase } = await import('../cursor/bootstrapProject');
      const result = await ensureCompileDatabase(
        ctx,
        settings,
        extensionPath ?? '',
        (msg) => ctx.outputChannel.appendLine(msg),
        { force: true },
      );
      mode = result.mode;
      if (extensionPath && settings.upsertClangdConfig && ctx.project) {
        await ensureUhtIntellisense(ctx.project, extensionPath, undefined, { lazyPluginIndexing: settings.clangdLazyPluginIndexing });
      }
      await requestClangdRestart(ctx.project!.projectRoot, 'manual compile database refresh', (msg) => ctx.outputChannel.appendLine(msg));
      if (result.mode === 'ready') {
        vscode.window.showInformationMessage('UE5_8 Cursor: IntelliSense 데이터 갱신 완료.');
      } else if (result.mode === 'partial') {
        vscode.window.showInformationMessage('UE5_8 Cursor: IntelliSense 부분 갱신 (에디터 빌드 권장).');
      } else {
        vscode.window.showWarningMessage('UE5_8 Cursor: compile_commands.json 생성 실패.');
      }
    },
  );
  return mode;
}

function extractClangDatabasePath(output: string): string | undefined {
  const m = output.match(/ClangDatabase written to\s+(.+?)(?:\r?\n|$)/im);
  return m?.[1]?.trim().replace(/[/\\]+$/, '');
}

export async function findAndPlaceCompileCommands(
  ctx: UE5_8CursorContext,
  ubtReportedPath?: string,
  options?: { overwrite?: boolean },
): Promise<boolean> {
  if (!ctx.project || !ctx.engine) return false;

  const projectRoot = ctx.project.projectRoot;
  const targetPath = path.join(projectRoot, 'compile_commands.json');

  const tryCopy = async (source: string, label: string): Promise<boolean> => {
    if (!(await fileExists(source))) return false;
    if (path.normalize(source) === path.normalize(targetPath)) return true;
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Copying compile_commands.json (${label})`);
    await fs.promises.copyFile(source, targetPath);
    return true;
  };

  if ((await fileExists(targetPath)) && !options?.overwrite) return true;
  if (ubtReportedPath && (await tryCopy(ubtReportedPath, 'UBT output'))) return true;

  const engineDb = path.join(ctx.engine.root, 'compile_commands.json');
  if (await tryCopy(engineDb, 'engine root')) return true;

  const searchBases = [
    path.join(projectRoot, 'Intermediate', 'Build'),
    path.join(ctx.engine.root, 'Intermediate', 'Build'),
  ];

  for (const base of searchBases) {
    const found = await findFileRecursive(base, 'compile_commands.json', 6);
    if (found && (await tryCopy(found, 'Intermediate search'))) return true;
  }

  return false;
}

async function findFileRecursive(dir: string, filename: string, depth: number): Promise<string | undefined> {
  if (depth <= 0) return undefined;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return full;
      if (entry.isDirectory()) {
        const found = await findFileRecursive(full, filename, depth - 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}
