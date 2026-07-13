import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import { ensureGeneratedWorkspace, ensureCursorRules } from './workspaceSetup';
import { ensureUhtIntellisense, ensureMcpIntegration } from './projectSetup';
import { ensureShaderIntellisense } from './shaderIntellisense';
import { ensureMultiRootWorkspace } from './multiRootWorkspace';
import { discoverModuleLayouts } from '../parsers/moduleLayout';
import { findClangdPath } from '../detection/prerequisites';
import { generateCompileDatabaseFromRsp } from './compileDatabaseFromRsp';
import { generateCompileDatabaseFromBuildCs } from './compileDatabaseFromBuildCs';
import { buildCommandLine, generateClangDatabaseCommandLine, formatCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { findAndPlaceCompileCommands } from '../commands/setupCommands';
import type { UE5_8CursorContext } from '../types';
import type { UE5_8CursorSettings } from '../config/settings';
import { mutateJson, runWithTransaction, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import type { CancellationToken } from 'vscode';
import { resolveSnapshotKey } from '../projectModel/snapshotKey';
import { readCompileDatabaseMetadata, writeCompileDatabaseMetadata } from '../projectModel/compileDatabaseMetadata';
import { requestClangdRestart } from './clangdLifecycle';
import { sanitizeCompileCommand, type RawCompileDatabaseEntry } from '../projectModel/compileCommandSanitizer';

export type IntelliSenseMode = 'ready' | 'partial' | 'missing';

export interface BootstrapResult {
  intelliSense: IntelliSenseMode;
  compileDbSource?: 'rsp' | 'ubt' | 'buildcs';
  compileDbEntries?: number;
  clangdPath?: string;
  indexPlan?: CompileDbIndexPlan;
  /** True when a UHT cache warm-up (UBT Editor build) should run in the background. */
  warmupPending?: boolean;
  errors: string[];
}

export interface CompileDbIndexPlan {
  projectTus: number;
  pluginTus: number;
}

function extractClangDatabasePath(output: string): string | undefined {
  const m = output.match(/ClangDatabase written to\s+(.+?)(?:\r?\n|$)/im);
  return m?.[1]?.trim().replace(/[/\\]+$/, '');
}

async function isSyntheticCompileDatabase(compileDbPath: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(compileDbPath, 'utf-8');
    return content.includes('UE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1');
  } catch {
    return false;
  }
}

async function pathContainsGeneratedHeaders(dir: string, depth: number): Promise<boolean> {
  if (depth <= 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.generated.h')) {
      return true;
    }
    if (entry.isDirectory() && (await pathContainsGeneratedHeaders(full, depth - 1))) {
      return true;
    }
  }
  return false;
}

async function hasUhtGeneratedCache(projectRoot: string): Promise<boolean> {
  return pathContainsGeneratedHeaders(path.join(projectRoot, 'Intermediate', 'Build'), 9);
}

async function projectUsesUht(projectRoot: string): Promise<boolean> {
  const roots = [path.join(projectRoot, 'Source'), path.join(projectRoot, 'Plugins')];

  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth <= 0) return false;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'Intermediate' || entry.name === 'Binaries') continue;
        if (await walk(full, depth - 1)) return true;
      } else if (entry.isFile() && entry.name.endsWith('.h')) {
        try {
          const content = await fs.promises.readFile(full, 'utf-8');
          if (
            content.includes('.generated.h') ||
            /\bUCLASS\s*\(|\bUSTRUCT\s*\(|\bUENUM\s*\(|\bUINTERFACE\s*\(/.test(content)
          ) {
            return true;
          }
        } catch {
          // ignore unreadable headers
        }
      }
    }
    return false;
  }

  for (const root of roots) {
    if (await walk(root, 8)) return true;
  }
  return false;
}

/**
 * Whether a UHT cache warm-up (UBT Editor build) is needed: project uses UHT
 * but no *.generated.h cache exists yet. Used to schedule a background warm-up
 * so editor activation is not blocked by a multi-minute build (Rider-style).
 */
export async function needsCacheWarmup(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
): Promise<boolean> {
  if (!ctx.project || !ctx.engine || !settings.autoWarmUnrealCacheOnOpen) return false;
  if (await hasUhtGeneratedCache(ctx.project.projectRoot)) return false;
  return projectUsesUht(ctx.project.projectRoot);
}

/**
 * Run the UBT Editor build that generates the UHT *.generated.h cache.
 * Streams output through onLine (for status-bar build progress) and log.
 */
export async function runCacheWarmup(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  log: (msg: string) => void,
  onLine?: (line: string) => void,
  token?: CancellationToken,
): Promise<boolean> {
  if (!ctx.project || !ctx.engine) return false;

  const cmd = buildCommandLine(ctx.engine, ctx.project, {
    configuration: 'Development',
    targetType: 'Editor',
    platform: settings.platform,
    editorRunning: false,
    additionalArgs: ['-NoHotReloadFromIDE'],
  });

  log('[UE5_8 Cursor] No UHT generated cache found — warming Unreal cache with UBT Editor build...');
  log(`[UE5_8 Cursor] ${formatCommandLine(cmd)}`);

  const sink = (line: string) => {
    log(line);
    onLine?.(line);
  };
  const result = await spawnAsync(cmd.executable, cmd.args, {
    onStdout: sink,
    onStderr: sink,
    token,
  });

  const generated = await hasUhtGeneratedCache(ctx.project.projectRoot);
  if (result.exitCode === 0) {
    log('[UE5_8 Cursor] Unreal cache warm-up completed.');
  } else if (generated) {
    log('[UE5_8 Cursor] Unreal cache warm-up reported errors, but UHT generated headers were created.');
  } else {
    log('[UE5_8 Cursor] Unreal cache warm-up failed before UHT generated headers were created.');
  }
  return generated;
}

export async function ensureCompileDatabase(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
  log: (msg: string) => void,
  options?: { force?: boolean; fast?: boolean; tx?: WorkspaceMutationTransaction; token?: CancellationToken },
): Promise<{ mode: IntelliSenseMode; source?: BootstrapResult['compileDbSource']; entries?: number }> {
  if (!ctx.project) return { mode: 'missing' };

  const projectRoot = ctx.project.projectRoot;
  const compileDb = path.join(projectRoot, 'compile_commands.json');
  const snapshotKey = resolveSnapshotKey({
    project: ctx.project,
    targetType: settings.buildTarget,
    platform: settings.platform,
    configuration: settings.buildConfiguration,
  });
  const hasCompileDb = await fileExists(compileDb);
  const existingSynthetic = hasCompileDb ? await isSyntheticCompileDatabase(compileDb) : false;
  const existingMetadata = hasCompileDb ? await readCompileDatabaseMetadata(projectRoot) : undefined;
  if (
    hasCompileDb && !options?.force && existingMetadata?.authoritative &&
    existingMetadata.snapshotKey === snapshotKey.snapshotKey
  ) {
    return { mode: 'ready', source: 'ubt', entries: existingMetadata.uniqueTuCount };
  }

  if (!ctx.engine) {
    if (!hasCompileDb) return { mode: 'missing' };
    return { mode: 'partial', source: existingSynthetic ? 'buildcs' : 'rsp' };
  }

  if (settings.autoGenerateCompileCommands && !options?.fast) {
    const cmd = generateClangDatabaseCommandLine(ctx.engine, ctx.project, {
      configuration: settings.buildConfiguration,
      platform: settings.platform,
      targetType: settings.buildTarget,
    });
    log(`[UE5_8 Cursor] UBT GenerateClangDatabase: ${formatCommandLine(cmd)}`);
    const clangdPath = await findClangdPath(settings.llvmPath, extensionPath);
    const env = { ...process.env };
    if (clangdPath) {
      const binDir = path.dirname(clangdPath);
      // The VSIX bundles clangd next to its compiler drivers. Do not set
      // LLVM_ROOT from a clangd-only layout: UBT interprets it as a complete
      // LLVM installation and then fails looking for <LLVM_ROOT>/bin/clang++.
      // PATH lets UBT find a bundled clang++ when present while preserving a
      // user's explicitly configured native toolchain.
      env.PATH = `${binDir};${env.PATH ?? ''}`;
      // UBT's Windows platform scanner accepts LLVM_PATH only as an LLVM root
      // containing bin/clang++.exe. The VSIX uses exactly that layout.
      if (await fileExists(path.join(binDir, 'bin', 'clang++.exe'))) {
        env.LLVM_PATH = binDir;
      }
    }
    const ubtOutput: string[] = [];
    const capture = (line: string) => {
      ubtOutput.push(line);
      log(line);
    };
    const result = await spawnAsync(cmd.executable, cmd.args, {
      env,
      onStdout: capture,
      onStderr: capture,
      token: options?.token,
    });
    if (result.exitCode === 0) {
      const placed = await findAndPlaceCompileCommands(
        ctx,
        extractClangDatabasePath(ubtOutput.join('\n')),
        { overwrite: options?.force },
      );
      if (placed) {
        const entries = await normalizeUbtCompileDatabase(projectRoot, options?.tx);
        if (entries.length > 0) {
          await writeCompileDatabaseMetadata(projectRoot, 'ubt', entries, snapshotKey, options?.tx);
          log(`[UE5_8 Cursor] compile_commands from UBT (${entries.length} unique project TU actions)`);
          return { mode: 'ready', source: 'ubt', entries: entries.length };
        }
        log('[UE5_8 Cursor] UBT database contained no project translation-unit actions');
      }
      log('[UE5_8 Cursor] UBT completed but compile_commands.json was not found');
    }
    log('[UE5_8 Cursor] UBT GenerateClangDatabase failed — Build.cs fallback');
  }

  const rsp = await generateCompileDatabaseFromRsp(projectRoot, ctx.engine.root, options?.tx, snapshotKey);
  if (rsp.ok) {
    const entries = await normalizeUbtCompileDatabase(projectRoot, options?.tx);
    await writeCompileDatabaseMetadata(projectRoot, 'rsp', entries, snapshotKey, options?.tx);
    log(`[UE5_8 Cursor] compile_commands from module RSP fallback (${entries.length} entries; partial until UBT actions are available)`);
    return { mode: 'partial', source: 'rsp', entries: entries.length };
  }

  if (hasCompileDb && !existingSynthetic && existingMetadata?.authoritative) {
    log('[UE5_8 Cursor] Keeping the last verified UBT compile_commands.json after refresh failed.');
    return { mode: 'partial', source: 'ubt', entries: existingMetadata.uniqueTuCount };
  }

  const synthetic = await generateCompileDatabaseFromBuildCs(projectRoot, ctx.engine.root, options?.tx);
  if (synthetic.ok) {
    const entries = await normalizeUbtCompileDatabase(projectRoot, options?.tx);
    await writeCompileDatabaseMetadata(projectRoot, 'buildcs', entries, snapshotKey, options?.tx);
    log(`[UE5_8 Cursor] compile_commands from Build.cs synthetic (${entries.length} entries)`);
    return { mode: 'partial', source: 'buildcs', entries: entries.length };
  }

  return { mode: 'missing' };
}

export async function bootstrapProject(
  ctx: UE5_8CursorContext,
  settings: UE5_8CursorSettings,
  extensionPath: string,
): Promise<BootstrapResult> {
  const errors: string[] = [];
  const log = (msg: string) => ctx.outputChannel.appendLine(msg);

  if (!ctx.project) {
    return { intelliSense: 'missing', errors: ['No project'] };
  }

  log('[UE5_8 Cursor] === Zero-Touch Bootstrap v6 ===');

  const clangdPath = await findClangdPath(settings.llvmPath, extensionPath);
  if (clangdPath) {
    log(`[UE5_8 Cursor] clangd: ${clangdPath}`);
  } else {
    errors.push('clangd not found');
    log('[UE5_8 Cursor] WARNING: clangd not found');
  }

  const result = await runWithTransaction(ctx.project.projectRoot, async (tx) => {
    if (settings.upsertClangdConfig && extensionPath) {
      await ensureUhtIntellisense(ctx.project!, extensionPath, tx, { lazyPluginIndexing: settings.clangdLazyPluginIndexing });
      const layouts = await discoverModuleLayouts(ctx.project!.projectRoot);
      if (layouts.length > 0) {
        log(`[UE5_8 Cursor] Module Public/Private: ${layouts.map((l) => l.moduleName).join(', ')}`);
      }
    }

    const { settings: wsChanged, gitignore: giChanged, debug } = await ensureGeneratedWorkspace(ctx.project!, {
      clangdPath,
      applyExplorerFilter: settings.hideExplorerNoise,
      contentBrowserMode: settings.contentBrowserMode,
      engine: ctx.engine,
      debugConfiguration: settings.debugBuildConfiguration,
      platform: settings.platform,
      tx,
    });
    if (wsChanged) log('[UE5_8 Cursor] .vscode/settings.json updated');
    if (giChanged) log('[UE5_8 Cursor] .gitignore updated');
    if (debug?.launch || debug?.tasks) log('[UE5_8 Cursor] debug configs updated');

    if (extensionPath && settings.mcpEnabled) {
      await ensureMcpIntegration(ctx.project!, extensionPath, settings, tx);
    }

    await ensureShaderIntellisense(ctx.project!, ctx.engine?.root, tx);
    await ensureMultiRootWorkspace(ctx.project!, {
      clangdPath,
      applyExplorerFilter: settings.hideExplorerNoise,
      contentBrowserMode: settings.contentBrowserMode,
    }, tx);
    await ensureCursorRules(ctx.project!, tx);

    const warmupPending = await needsCacheWarmup(ctx, settings);
    let compileResult: {
      mode: IntelliSenseMode;
      source?: BootstrapResult['compileDbSource'];
      entries?: number;
    } = { mode: 'missing' };
    if (settings.autoSetupOnOpen) {
      const compileDb = path.join(ctx.project!.projectRoot, 'compile_commands.json');
      const forceCompileDb = await isSyntheticCompileDatabase(compileDb);
      compileResult = await ensureCompileDatabase(ctx, settings, extensionPath, log, {
        force: forceCompileDb,
        fast: warmupPending,
        tx,
      });
      if (settings.upsertClangdConfig && extensionPath) {
        await ensureUhtIntellisense(ctx.project!, extensionPath, tx, { lazyPluginIndexing: settings.clangdLazyPluginIndexing });
      }
    }

    if (warmupPending) {
      log('[UE5_8 Cursor] IntelliSense partial — warming UHT cache in background for full accuracy');
    } else if (compileResult.mode === 'partial') {
      log('[UE5_8 Cursor] IntelliSense partial — launch editor once for full accuracy');
    }

    const indexPlan = await getCompileDbIndexPlan(ctx.project!.projectRoot);
    if (indexPlan.pluginTus > 0 && settings.clangdLazyPluginIndexing) {
      log(`[UE5_8 Cursor] Project source indexing: ${indexPlan.projectTus} TU(s); ${indexPlan.pluginTus} plugin TU(s) deferred until opened.`);
    }

    return {
      intelliSense: warmupPending && compileResult.mode === 'missing' ? 'partial' : compileResult.mode,
      compileDbSource: compileResult.source,
      compileDbEntries: compileResult.entries,
      clangdPath,
      indexPlan,
      warmupPending,
      errors,
    };
  });

  // Settings are written atomically while bootstrapping. Restart only after
  // the transaction has committed and Cursor has observed the new workspace
  // settings, otherwise clangd may be launched with its default PATH value.
  await restartClangdAfterSettings(ctx, clangdPath, log);
  return result;
}

type CompileDbEntry = RawCompileDatabaseEntry;

export async function getCompileDbIndexPlan(projectRoot: string): Promise<CompileDbIndexPlan> {
  const filePath = path.join(projectRoot, 'compile_commands.json');
  try {
    const entries = JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as CompileDbEntry[];
    if (!Array.isArray(entries)) return { projectTus: 0, pluginTus: 0 };
    let projectTus = 0;
    let pluginTus = 0;
    for (const entry of entries) {
      if (!entry?.file) continue;
      if (/[\\/]Plugins[\\/]/i.test(entry.file)) pluginTus++;
      else projectTus++;
    }
    return { projectTus, pluginTus };
  } catch {
    return { projectTus: 0, pluginTus: 0 };
  }
}

function isProjectTranslationUnit(projectRoot: string, filePath: string): boolean {
  const absolute = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, '/');
  return /^(?:Source|Plugins\/[^/]+\/Source)\//i.test(relative) && /\.(?:cpp|cc|cxx|c)$/i.test(absolute);
}

/** UBT may emit engine actions too; retain one command per project/plugin TU. */
async function normalizeUbtCompileDatabase(projectRoot: string, tx?: WorkspaceMutationTransaction): Promise<CompileDbEntry[]> {
  const filePath = path.join(projectRoot, 'compile_commands.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: CompileDbEntry[] = [];
  for (const entry of raw as CompileDbEntry[]) {
    if (!entry?.file) continue;
    const absoluteFile = path.isAbsolute(entry.file)
      ? path.normalize(entry.file)
      : path.resolve(entry.directory ?? projectRoot, entry.file);
    if (!isProjectTranslationUnit(projectRoot, absoluteFile)) continue;
    const canonical = absoluteFile.toLowerCase();
    if (seen.has(canonical)) continue;
    const sanitized = sanitizeCompileCommand({ ...entry, file: absoluteFile });
    if (!sanitized) continue;
    seen.add(canonical);
    entries.push(sanitized);
  }
  // clangd indexes in database order. Put the game's primary Source tree
  // before plugin sources so interactive project files become usable first.
  entries.sort((a, b) => {
    const aPlugin = /[\\/]Plugins[\\/]/i.test(a.file ?? '') ? 1 : 0;
    const bPlugin = /[\\/]Plugins[\\/]/i.test(b.file ?? '') ? 1 : 0;
    return aPlugin - bPlugin || (a.file ?? '').localeCompare(b.file ?? '');
  });
  if (entries.length > 0) await mutateJson(tx, projectRoot, filePath, entries);
  return entries;
}

async function restartClangdAfterSettings(
  ctx: UE5_8CursorContext,
  clangdPath: string | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!clangdPath) return;
  const uri = vscode.window.activeTextEditor?.document.uri;
  const expected = path.normalize(clangdPath).toLowerCase();
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const configured = vscode.workspace.getConfiguration('clangd', uri).get<string>('path') ?? '';
    if (path.normalize(configured).toLowerCase() === expected) {
      if (ctx.project) await requestClangdRestart(ctx.project.projectRoot, 'workspace settings update', log);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  log('[UE5_8 Cursor] ERROR: clangd workspace setting was not applied; reload the window before using navigation.');
  vscode.window.showWarningMessage(
    'UE5_8 Cursor: clangd 설정이 현재 workspace에 적용되지 않았습니다. Developer: Reload Window를 실행하세요.',
  );
}
