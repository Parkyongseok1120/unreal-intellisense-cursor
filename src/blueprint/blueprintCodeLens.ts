import * as vscode from 'vscode';
import * as path from 'path';
import { parseUClassFromText } from '../blueprint/cppClassParser';
import { findBlueprintsForClass } from '../blueprint/blueprintFinder';
import { openAssetInEditor, createBlueprintSubclassInEditor } from '../blueprint/blueprintEditor';
import { blueprintLabelFromEntry } from '../blueprint/types';
import type { UE5_8CursorContext } from '../types';

export class BlueprintCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly getCtx: (uri: vscode.Uri) => UE5_8CursorContext) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const ctx = this.getCtx(document.uri);
    if (!ctx.project || document.languageId !== 'cpp') return [];

    const text = document.getText();
    if (!text.includes('UCLASS')) return [];

    const classes = parseUClassFromText(text);
    const lenses: vscode.CodeLens[] = [];

    for (const cls of classes) {
      const range = new vscode.Range(cls.line, 0, cls.line, 0);
      const bps = await findBlueprintsForClass(
        ctx.project.projectRoot,
        cls.className,
        ctx.editorBridge?.hasCapability('blueprintGraph') ? ctx.editorBridge : undefined,
      );

      if (bps.length > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(symbol-class) BP: ${bps.map((b) => b.assetName).join(', ')}`,
            tooltip: '연결된 Blueprint — 클릭하여 에디터에서 열기',
            command: 'ue58rider.openBlueprint',
            arguments: [bps[0].assetPath],
          }),
        );
        if (bps.length > 1) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `$(list-selection) ${bps.length} Blueprints...`,
              command: 'ue58rider.findBlueprints',
              arguments: [cls.className],
            }),
          );
        }
      } else if (ctx.editorBridge?.isConnected() && ctx.editorBridge.canCall('blueprint.findImplementations')) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(search) Find BP implementations...',
            tooltip: 'Bridge: Blueprint classes implementing this C++ type',
            command: 'ue58rider.findBlueprintImplementations',
            arguments: [cls.className],
          }),
        );
      } else if (cls.isBlueprintable) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(add) Create Blueprint subclass',
            tooltip: '이 C++ 클래스를 부모로 Blueprint 생성 (에디터)',
            command: 'ue58rider.createBlueprintSubclass',
            arguments: [cls.className],
          }),
        );
      }

      if (ctx.editorBridge?.isConnected() && ctx.editorBridge.canCall('blueprint.propertyOverrides')) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(settings-gear) BP property overrides',
            tooltip: 'Bridge: show Blueprint property overrides for this class',
            command: 'ue58rider.showBlueprintPropertyOverrides',
            arguments: [cls.className],
          }),
        );
      }
    }

    return lenses;
  }
}

export async function openBlueprintInEditor(
  ctx: UE5_8CursorContext,
  assetPath: string,
): Promise<void> {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('UE5_8 Cursor: 프로젝트 또는 엔진이 없습니다.');
    return;
  }

  try {
    await openAssetInEditor(ctx.engine, ctx.project, assetPath);
    vscode.window.showInformationMessage(`UE5_8 Cursor: Blueprint 열기 — ${assetPath}`);
  } catch (err) {
    vscode.window.showErrorMessage(`UE5_8 Cursor: Blueprint 열기 실패 — ${err}`);
  }
}

export async function findAndPickBlueprint(ctx: UE5_8CursorContext, className: string): Promise<void> {
  if (!ctx.project) return;

  const bridge = ctx.editorBridge?.hasCapability('blueprintGraph') ? ctx.editorBridge : undefined;
  const bps = await findBlueprintsForClass(ctx.project.projectRoot, className, bridge);
  if (bps.length === 0) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: ${className}에 연결된 Blueprint를 찾지 못했습니다.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    bps.map((b) => ({ label: b.assetName, description: b.assetPath, assetPath: b.assetPath })),
    { placeHolder: `${className} Blueprint 선택` },
  );
  if (picked) await openBlueprintInEditor(ctx, picked.assetPath);
}

export async function createBlueprintSubclass(ctx: UE5_8CursorContext, className: string): Promise<void> {
  if (!ctx.project || !ctx.engine) return;

  const bpName = await vscode.window.showInputBox({
    prompt: 'Blueprint 이름',
    value: `BP_${className.replace(/^[AU]/, '')}`,
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : '유효한 이름을 입력하세요'),
  });
  if (!bpName) return;

  try {
    await createBlueprintSubclassInEditor(ctx.engine, ctx.project, className, bpName);
    vscode.window.showInformationMessage(`UE5_8 Cursor: Blueprint 생성 요청 — ${bpName} (에디터 확인)`);
  } catch (err) {
    vscode.window.showErrorMessage(`UE5_8 Cursor: Blueprint 생성 실패 — ${err}`);
  }
}

export async function jumpToCppFromBlueprint(ctx: UE5_8CursorContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!ctx.project) return;

  let blueprintName: string | undefined;
  let assetPath: string | undefined;

  if (editor?.document.fileName.endsWith('.uasset')) {
    blueprintName = path.basename(editor.document.fileName, '.uasset');
  } else {
    blueprintName = await vscode.window.showInputBox({
      prompt: 'Blueprint 에셋 이름 (e.g. BP_EnemyCharacter)',
    });
  }
  if (!blueprintName) return;

  const { findCppClassForBlueprintName, findBlueprintAssetByName } = await import('../blueprint/blueprintFinder');
  const { mcpGetBlueprintParentClass } = await import('../blueprint/mcpBlueprintBridge');

  const bp = await findBlueprintAssetByName(ctx.project.projectRoot, blueprintName);
  if (bp) assetPath = bp.assetPath;

  let parentClass: string | undefined;
  if (assetPath) {
    parentClass = await mcpGetBlueprintParentClass(assetPath);
  }

  const searchName = parentClass ?? blueprintName;
  const files = await findCppClassForBlueprintName(ctx.project.projectRoot, searchName);

  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `UE5_8 Cursor: ${blueprintName}에 대응하는 C++ 파일 없음` +
        (parentClass ? ` (MCP 부모: ${parentClass})` : ''),
    );
    return;
  }

  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: path.basename(f), description: f, path: f })),
      { placeHolder: 'C++ 파일 선택' },
    );
    if (!picked) return;
    const doc = await vscode.workspace.openTextDocument(picked.path);
    await vscode.window.showTextDocument(doc);
    return;
  }

  const header = files.find((f) => f.endsWith('.h')) ?? files[0];
  const doc = await vscode.workspace.openTextDocument(header);
  await vscode.window.showTextDocument(doc);
}

export async function findBlueprintImplementations(ctx: UE5_8CursorContext, className: string): Promise<void> {
  if (!ctx.project || !ctx.editorBridge?.isConnected()) {
    vscode.window.showWarningMessage('UE5_8 Cursor: Editor bridge required for Blueprint implementations.');
    return;
  }
  const implementations = await ctx.editorBridge.findBlueprintImplementations(className);
  if (implementations.length === 0) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: No Blueprint implementations for ${className}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    implementations.map((b) => ({ label: blueprintLabelFromEntry(b), description: b.assetPath, assetPath: b.assetPath })),
    { placeHolder: `${className} Blueprint implementations` },
  ) as { assetPath: string } | undefined;
  if (picked) await openBlueprintInEditor(ctx, picked.assetPath);
}

export async function showBlueprintPropertyOverrides(ctx: UE5_8CursorContext, className: string): Promise<void> {
  if (!ctx.project || !ctx.editorBridge?.isConnected()) {
    vscode.window.showWarningMessage('UE5_8 Cursor: Editor bridge required for property overrides.');
    return;
  }
  const overrides = await ctx.editorBridge.getBlueprintPropertyOverrides(className);
  if (overrides.length === 0) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: No Blueprint property overrides for ${className}.`);
    return;
  }
  const channel = vscode.window.createOutputChannel('UE5_8 Blueprint Overrides');
  channel.clear();
  channel.appendLine(`Property overrides for ${className}:`);
  for (const entry of overrides) {
    channel.appendLine(`  ${entry.property} = ${entry.value}`);
  }
  channel.show(true);
}
