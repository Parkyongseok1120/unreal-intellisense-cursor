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
import { runWithTransaction, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import type { CancellationToken } from 'vscode';

export type IntelliSenseMode = 'ready' | 'partial' | 'missing';

export interface BootstrapResult {
  intelliSense: IntelliSenseMode;
  compileDbSource?: 'rsp' | 'ubt' | 'buildcs';
  compileDbEntries?: number;
  clangdPath?: string;
  /** True when a UHT cache warm-up (UBT Editor build) should run in the background. */
  warmupPending?: boolean;
  errors: string[];
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
  const hasCompileDb = await fileExists(compileDb);
  const existingSynthetic = hasCompileDb ? await isSyntheticCompileDatabase(compileDb) : false;
  if (hasCompileDb && !options?.force) {
    return { mode: existingSynthetic ? 'partial' : 'ready', source: existingSynthetic ? 'buildcs' : 'rsp' };
  }

  if (!ctx.engine) {
    if (!hasCompileDb) return { mode: 'missing' };
    return { mode: existingSynthetic ? 'partial' : 'ready', source: existingSynthetic ? 'buildcs' : 'rsp' };
  }

  const rsp = await generateCompileDatabaseFromRsp(projectRoot, ctx.engine.root, options?.tx);
  if (rsp.ok) {
    log(`[UE5_8 Cursor] compile_commands from .rsp (${rsp.entryCount} entries)`);
    return { mode: 'ready', source: 'rsp', entries: rsp.entryCount };
  }

  if (settings.autoGenerateCompileCommands && !options?.fast) {
    const cmd = generateClangDatabaseCommandLine(ctx.engine, ctx.project, {
      configuration: settings.buildConfiguration,
      platform: settings.platform,
    });
    log(`[UE5_8 Cursor] UBT GenerateClangDatabase: ${formatCommandLine(cmd)}`);
    const clangdPath = await findClangdPath(settings.llvmPath, extensionPath);
    const env = { ...process.env };
    if (clangdPath) {
      const binDir = path.dirname(clangdPath);
      const llvmRoot = path.basename(binDir) === 'bin' ? path.dirname(binDir) : binDir;
      env.LLVM_ROOT = llvmRoot;
      env.PATH = `${binDir};${env.PATH ?? ''}`;
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
        log('[UE5_8 Cursor] compile_commands from UBT');
        return { mode: 'ready', source: 'ubt' };
      }
      log('[UE5_8 Cursor] UBT completed but compile_commands.json was not found');
    }
    log('[UE5_8 Cursor] UBT GenerateClangDatabase failed — Build.cs fallback');
  }

  if (hasCompileDb && !existingSynthetic) {
    log('[UE5_8 Cursor] Keeping existing compile_commands.json after refresh fallback failed.');
    return { mode: 'ready', source: 'ubt' };
  }

  const synthetic = await generateCompileDatabaseFromBuildCs(projectRoot, ctx.engine.root, options?.tx);
  if (synthetic.ok) {
    log(`[UE5_8 Cursor] compile_commands from Build.cs synthetic (${synthetic.entryCount} entries)`);
    return { mode: 'partial', source: 'buildcs', entries: synthetic.entryCount };
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

  return await runWithTransaction(ctx.project.projectRoot, async (tx) => {
    if (settings.upsertClangdConfig && extensionPath) {
      await ensureUhtIntellisense(ctx.project!, extensionPath, tx);
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
    await ensureMultiRootWorkspace(ctx.project!, tx);
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
        await ensureUhtIntellisense(ctx.project!, extensionPath, tx);
      }
      try {
        await vscode.commands.executeCommand('clangd.restart');
      } catch {
        // clangd extension may not be active yet
      }
    }

    if (warmupPending) {
      log('[UE5_8 Cursor] IntelliSense partial — warming UHT cache in background for full accuracy');
    } else if (compileResult.mode === 'partial') {
      log('[UE5_8 Cursor] IntelliSense partial — launch editor once for full accuracy');
    }

    return {
      intelliSense: warmupPending && compileResult.mode === 'missing' ? 'partial' : compileResult.mode,
      compileDbSource: compileResult.source,
      compileDbEntries: compileResult.entries,
      clangdPath,
      warmupPending,
      errors,
    };
  });
}
