import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { UEProject, UEInstallation, BuildConfiguration } from '../types';
import {
  getExplorerFilterSettings,
  getFilesExclude,
  getSearchExclude,
  getWatcherExclude,
  isExplorerFilterApplied,
  stripExplorerFilterMarkers,
} from './explorerFilter';
import { GENERATED_SETTINGS_FLAG, GITIGNORE_MARKER, GENERATED_GITIGNORE_LINES } from './generatedArtifacts';
import { mutateJson, mutateText, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function readSettingsFile(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

/** UE translation units have large preambles; cap concurrency by memory, not CPU count. */
export function recommendedClangdJobs(
  totalMemory = os.totalmem(),
  cpuCount = os.cpus().length,
): number {
  const gib = 1024 ** 3;
  const memoryBound = totalMemory < 16 * gib ? 2 : totalMemory < 48 * gib ? 3 : totalMemory < 96 * gib ? 4 : 6;
  return Math.max(2, Math.min(memoryBound, Math.max(2, Math.floor(cpuCount / 2))));
}

export function recommendedPchStorage(_totalMemory = os.totalmem()): 'disk' {
  // UE's SharedPCH fan-out is large enough that clangd's in-memory PCH cache
  // can consume 8–12 GiB even on a 32 GiB workstation. Disk storage keeps the
  // cache reusable across restarts without competing with UBT/UnrealEditor.
  // Do not infer "memory" from installed RAM: available memory is volatile.
  return 'disk';
}

export function buildUeSettings(options: {
  clangdPath?: string;
  existingClangdPath?: unknown;
  applyExplorerFilter?: boolean;
  contentBrowserMode?: import('./explorerFilter').ContentBrowserMode;
}): Record<string, unknown> {
  const ueSettings: Record<string, unknown> = {
    [GENERATED_SETTINGS_FLAG]: true,
    'C_Cpp.intelliSenseEngine': 'disabled',
    'C_Cpp.autocomplete': 'disabled',
    'C_Cpp.errorSquiggles': 'disabled',
    'clangd.path': options.clangdPath ?? options.existingClangdPath ?? '',
    'clangd.arguments': [
      '--background-index',
      '--background-index-priority=low',
      '--compile-commands-dir=${workspaceFolder}',
      '--completion-style=detailed',
      '--header-insertion=never',
      `--pch-storage=${recommendedPchStorage()}`,
      '--limit-results=500',
      `-j=${recommendedClangdJobs()}`,
    ],
    'clangd.fallbackFlags': ['-std=c++20', '-fms-compatibility', '-fms-extensions', '-Wno-unknown-pragmas'],
    'files.associations': {
      '*.h': 'cpp',
      '*.inl': 'cpp',
      '*.usf': 'hlsl',
      '*.ush': 'hlsl',
      '*.Build.cs': 'csharp',
      '*.Target.cs': 'csharp',
    },
    'editor.formatOnSave': false,
    'editor.suggest.snippetsPreventQuickSuggestions': false,
    'explorer.compactFolders': false,
    '[cpp]': {
      'editor.defaultFormatter': 'llvm-vs-code-extensions.vscode-clangd',
      'editor.wordBasedSuggestions': 'off',
      'editor.quickSuggestions': { other: true, comments: false, strings: false },
    },
  };

  if (options.applyExplorerFilter !== false) {
    Object.assign(ueSettings, getExplorerFilterSettings(options.contentBrowserMode ?? 'dedicated-view'));
  }

  return ueSettings;
}

/**
 * .vscode/settings.json — 플러그인이 자동 생성/갱신 (프로젝트에 커밋하지 않음)
 */
export async function ensureWorkspaceSettings(
  project: UEProject,
  options: {
    clangdPath?: string;
    applyExplorerFilter?: boolean;
    contentBrowserMode?: import('./explorerFilter').ContentBrowserMode;
    tx?: WorkspaceMutationTransaction;
  } = {},
): Promise<boolean> {
  const settingsPath = path.join(project.projectRoot, '.vscode', 'settings.json');
  const existing = await readSettingsFile(settingsPath);

  const ueSettings = buildUeSettings({
    clangdPath: options.clangdPath,
    existingClangdPath: existing['clangd.path'],
    applyExplorerFilter: options.applyExplorerFilter,
    contentBrowserMode: options.contentBrowserMode,
  });

  const merged = deepMerge(existing, ueSettings);
  const newContent = JSON.stringify(merged, null, 2) + '\n';
  const oldContent = JSON.stringify(existing, null, 2) + '\n';
  if (newContent === oldContent) return false;
  await mutateText(options.tx, project.projectRoot, settingsPath, newContent);
  return true;
}

export async function ensureGeneratedGitignore(
  projectRoot: string,
  tx?: WorkspaceMutationTransaction,
): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content = '';
  try {
    content = await fs.promises.readFile(gitignorePath, 'utf-8');
  } catch {
    content = '';
  }

  if (content.includes(GITIGNORE_MARKER)) {
    return false;
  }

  const block = '\n' + GENERATED_GITIGNORE_LINES.join('\n') + '\n';
  const newContent = content.endsWith('\n') || content.length === 0 ? content + block : content + '\n' + block;
  await mutateText(tx, projectRoot, gitignorePath, newContent);
  return true;
}

export async function applyExplorerFilter(project: UEProject): Promise<boolean> {
  return ensureWorkspaceSettings(project, { applyExplorerFilter: true });
}

export async function removeExplorerFilter(project: UEProject): Promise<boolean> {
  const settingsPath = path.join(project.projectRoot, '.vscode', 'settings.json');
  const existing = await readSettingsFile(settingsPath);
  if (!isExplorerFilterApplied(existing)) return false;

  const cleaned = stripExplorerFilterMarkers(existing);
  const mode =
    (existing['ue58rider.contentBrowser.mode'] as import('./explorerFilter').ContentBrowserMode | undefined) ??
    'dedicated-view';
  const managedFiles = getFilesExclude(mode);
  const managedSearch = getSearchExclude(mode);
  const managedWatcher = getWatcherExclude(mode);

  const nextFiles = removeManagedExplorerPatterns(
    cleaned['files.exclude'] as Record<string, boolean> | undefined,
    managedFiles,
  );
  const nextSearch = removeManagedExplorerPatterns(
    cleaned['search.exclude'] as Record<string, boolean> | undefined,
    managedSearch,
  );
  const nextWatcher = removeManagedExplorerPatterns(
    cleaned['files.watcherExclude'] as Record<string, boolean> | undefined,
    managedWatcher,
  );

  if (nextFiles) cleaned['files.exclude'] = nextFiles;
  else delete cleaned['files.exclude'];
  if (nextSearch) cleaned['search.exclude'] = nextSearch;
  else delete cleaned['search.exclude'];
  if (nextWatcher) cleaned['files.watcherExclude'] = nextWatcher;
  else delete cleaned['files.watcherExclude'];

  await mutateText(undefined, project.projectRoot, settingsPath, JSON.stringify(cleaned, null, 2) + '\n');
  return true;
}

function removeManagedExplorerPatterns(
  existing: Record<string, boolean> | undefined,
  managed: Record<string, boolean>,
): Record<string, boolean> | undefined {
  if (!existing) return undefined;
  const result = { ...existing };
  for (const key of Object.keys(managed)) {
    if (managed[key] === true) delete result[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function ensureCursorRules(
  project: UEProject,
  tx?: WorkspaceMutationTransaction,
): Promise<boolean> {
  const rulePath = path.join(project.projectRoot, '.cursor', 'rules', 'ue58-cpp.mdc');
  const content = `---
description: Unreal Engine 5.8 C++ conventions for this project
globs: **/*.{h,cpp,inl}
alwaysApply: false
---

# UE 5.8 C++ Rules

- Follow Epic coding standards: PascalCase types, F/A/U/T/E/I prefixes
- Use UCLASS/USTRUCT/UPROPERTY/UFUNCTION macros correctly
- Prefer TObjectPtr<> over raw UObject pointers (UE 5.8)
- Build with Editor target for development; use Live Coding when editor is open
- IntelliSense is powered by clangd + compile_commands.json — run "UE5_8 Cursor: Refresh IntelliSense" after adding modules
- .vscode / .cursor / compile_commands.json are plugin-generated — do not commit
`;

  try {
    const existing = await fs.promises.readFile(rulePath, 'utf-8');
    if (existing === content) return false;
  } catch {
    // new file
  }
  await mutateText(tx, project.projectRoot, rulePath, content);
  return true;
}

export async function ensureGeneratedWorkspace(
  project: UEProject,
  options: {
    clangdPath?: string;
    applyExplorerFilter?: boolean;
    contentBrowserMode?: import('./explorerFilter').ContentBrowserMode;
    engine?: UEInstallation;
    debugConfiguration?: BuildConfiguration;
    platform?: string;
    tx?: WorkspaceMutationTransaction;
  } = {},
): Promise<{ settings: boolean; gitignore: boolean; debug?: { launch: boolean; tasks: boolean } }> {
  const settings = await ensureWorkspaceSettings(project, {
    clangdPath: options.clangdPath,
    applyExplorerFilter: options.applyExplorerFilter,
    contentBrowserMode: options.contentBrowserMode,
    tx: options.tx,
  });
  const gitignore = await ensureGeneratedGitignore(project.projectRoot, options.tx);

  let debug: { launch: boolean; tasks: boolean } | undefined;
  if (options.engine && options.debugConfiguration) {
    const { ensureDebugConfigs } = await import('./launchConfig');
    debug = await ensureDebugConfigs(
      {
        project,
        engine: options.engine,
        debugConfiguration: options.debugConfiguration,
        platform: options.platform ?? 'Win64',
      },
      options.tx,
    );
  }

  return { settings, gitignore, debug };
}
