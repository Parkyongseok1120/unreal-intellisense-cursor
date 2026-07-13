import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_DATA_DIR } from '../constants';
import { captureDiagnosticBaseline } from '../diagnostics/diagnosticCapture';
import { readUbtBuildEvidence } from '../diagnostics/ubtBuildEvidence';
import { getCompileDbIndexPlan } from '../cursor/bootstrapProject';
import {
  getIntelliSenseMetricsTracker,
  startIntelliSenseMetricsRun,
  type IntelliSenseMetricsTracker,
} from '../telemetry/intellisenseMetrics';
import type { UE5_8CursorContext } from '../types';

export async function captureDiagnosticsForProject(ctx: UE5_8CursorContext): Promise<void> {
  if (!ctx.project) return;
  const result = await captureDiagnosticBaseline(ctx.project.projectRoot, {
    engineRoot: ctx.engine?.root,
    ubtBuild: await readUbtBuildEvidence(ctx.project.projectRoot),
  });
  const { summary } = result.baseline;
  ctx.outputChannel.appendLine(
    `[UE5_8 Cursor] Diagnostic baseline: ${summary.total} total, ${summary.errors} errors, ${summary.actionable} actionable. ${result.filePath}`,
  );
  const doc = await vscode.workspace.openTextDocument(result.filePath);
  await vscode.window.showTextDocument(doc, { preview: true });
}

function wordPosition(editor: vscode.TextEditor): vscode.Position | undefined {
  const selection = editor.selection;
  if (!selection.isEmpty) return selection.start;
  const range = editor.document.getWordRangeAtPosition(selection.active, /[A-Za-z_][A-Za-z0-9_]*/);
  return range?.start;
}

async function trackerFor(ctx: UE5_8CursorContext): Promise<IntelliSenseMetricsTracker | undefined> {
  if (!ctx.project) return undefined;
  const existing = getIntelliSenseMetricsTracker(ctx.project.projectRoot);
  if (existing) return existing;
  const tracker = await startIntelliSenseMetricsRun(ctx.project.projectRoot);
  tracker.markCompileDatabaseReady();
  tracker.markProjectModelReady(await getCompileDbIndexPlan(ctx.project.projectRoot));
  return tracker;
}

export async function benchmarkActiveDefinition(ctx: UE5_8CursorContext): Promise<void> {
  if (!ctx.project) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file' || editor.document.languageId !== 'cpp') {
    vscode.window.showWarningMessage('UE5_8 Cursor: open a C++ symbol before running the IntelliSense benchmark.');
    return;
  }
  const position = wordPosition(editor);
  if (!position) {
    vscode.window.showWarningMessage('UE5_8 Cursor: place the cursor on a C++ symbol before benchmarking F12.');
    return;
  }
  const tracker = await trackerFor(ctx);
  const started = performance.now();
  const definitions = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
    'vscode.executeDefinitionProvider', editor.document.uri, position,
  );
  const firstDefinitionMs = Math.round(performance.now() - started);
  const warmStarted = performance.now();
  const warmDefinitions = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
    'vscode.executeDefinitionProvider', editor.document.uri, position,
  );
  const warmDefinitionMs = Math.round(performance.now() - warmStarted);
  if (definitions?.length) tracker?.markProjectUsable(firstDefinitionMs);
  tracker?.recordWarmDefinitionTiming(warmDefinitionMs);
  await tracker?.sample();
  const metricsPath = tracker ? await tracker.save() : undefined;
  const baseline = await captureDiagnosticBaseline(ctx.project.projectRoot, {
    engineRoot: ctx.engine?.root,
    ubtBuild: await readUbtBuildEvidence(ctx.project.projectRoot),
  });
  const word = editor.document.getText(editor.document.getWordRangeAtPosition(position));
  ctx.outputChannel.appendLine(
    `[UE5_8 Cursor] F12 benchmark '${word}': first ${firstDefinitionMs} ms (${definitions?.length ?? 0}), warm ${warmDefinitionMs} ms (${warmDefinitions?.length ?? 0}). Metrics: ${metricsPath ?? 'unavailable'}`,
  );
  ctx.outputChannel.appendLine(
    `[UE5_8 Cursor] Diagnostic baseline captured: ${baseline.baseline.summary.total} diagnostic(s), ${baseline.baseline.summary.actionable} actionable.`,
  );
  if (definitions?.length) {
    vscode.window.showInformationMessage(`UE5_8 Cursor: F12 first ${firstDefinitionMs} ms, warm ${warmDefinitionMs} ms.`);
  } else {
    vscode.window.showWarningMessage(`UE5_8 Cursor: F12 benchmark returned no definition after ${firstDefinitionMs} ms.`);
  }
}

export async function showLatestIntelliSenseMetrics(ctx: UE5_8CursorContext): Promise<void> {
  if (!ctx.project) return;
  const active = getIntelliSenseMetricsTracker(ctx.project.projectRoot);
  if (active) {
    const metricsPath = await active.save();
    const doc = await vscode.workspace.openTextDocument(metricsPath);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  const metricsDir = path.join(ctx.project.projectRoot, EXTENSION_DATA_DIR, 'metrics');
  try {
    const entries = await fs.promises.readdir(metricsDir, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('intellisense-') && entry.name.endsWith('.json'))
      .map(async (entry) => ({ path: path.join(metricsDir, entry.name), stat: await fs.promises.stat(path.join(metricsDir, entry.name)) })));
    const latest = candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (!latest) throw new Error('No metrics files');
    const doc = await vscode.workspace.openTextDocument(latest.path);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    vscode.window.showInformationMessage('UE5_8 Cursor: no IntelliSense metrics have been captured for this project yet.');
  }
}
