import * as fs from 'fs';
import * as path from 'path';
import {
  CLANGD_MANAGED_BEGIN,
  CLANGD_MANAGED_END,
  EXTENSION_DATA_DIR,
  LEGACY_CLANGD_MANAGED_BEGIN,
  LEGACY_CLANGD_MANAGED_END,
} from '../constants';
import { mutateJson, mutateText, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

const PLUGIN_INDEX_STATE_FILE = 'clangd-plugin-index.json';
const MAX_PROMOTED_PLUGIN_ROOTS = 12;
const promotionQueues = new Map<string, Promise<unknown>>();

interface PluginIndexState {
  version: 1;
  promotedPluginRoots: string[];
}

function pluginIndexStatePath(projectRoot: string): string {
  return path.join(projectRoot, EXTENSION_DATA_DIR, PLUGIN_INDEX_STATE_FILE);
}

function normalizePluginRoot(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return /^Plugins\/.+$/i.test(normalized) ? normalized : undefined;
}

function escapePathRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

async function readPluginIndexState(projectRoot: string): Promise<PluginIndexState> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(pluginIndexStatePath(projectRoot), 'utf-8')) as Partial<PluginIndexState>;
    const promotedPluginRoots = Array.isArray(parsed.promotedPluginRoots)
      ? parsed.promotedPluginRoots
          .filter((root): root is string => typeof root === 'string')
          .map(normalizePluginRoot)
          .filter((root): root is string => !!root)
          .slice(-MAX_PROMOTED_PLUGIN_ROOTS)
      : [];
    return { version: 1, promotedPluginRoots: [...new Set(promotedPluginRoots)] };
  } catch {
    return { version: 1, promotedPluginRoots: [] };
  }
}

/** Returns the plugin descriptor root (`Plugins/...`) owning a source file. */
export function pluginRootForFile(projectRoot: string, filePath: string): string | undefined {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const match = relative.match(/^(Plugins\/.+)\/Source\//i);
  return match ? normalizePluginRoot(match[1]) : undefined;
}

/**
 * Promote the opened plugin's module from lazy background indexing. The small,
 * local state file is ignored by git and survives a clangd restart.
 */
export async function promotePluginIndexing(
  projectRoot: string,
  filePath: string,
  options: { tx?: WorkspaceMutationTransaction; lazyPluginIndexing?: boolean } = {},
): Promise<{ changed: boolean; pluginRoot?: string; promotedPluginRoots: string[] }> {
  const key = path.resolve(projectRoot).toLowerCase();
  const previous = promotionQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => promotePluginIndexingUnlocked(projectRoot, filePath, options));
  const queued = run.catch((err) => {
    console.error(`[UE5_8 Cursor] Plugin indexing promotion failed: ${err instanceof Error ? err.message : err}`);
  });
  promotionQueues.set(key, queued);
  try {
    return await run;
  } finally {
    if (promotionQueues.get(key) === queued) promotionQueues.delete(key);
  }
}

async function promotePluginIndexingUnlocked(
  projectRoot: string,
  filePath: string,
  options: { tx?: WorkspaceMutationTransaction; lazyPluginIndexing?: boolean },
): Promise<{ changed: boolean; pluginRoot?: string; promotedPluginRoots: string[] }> {
  const pluginRoot = pluginRootForFile(projectRoot, filePath);
  const state = await readPluginIndexState(projectRoot);
  if (!options.lazyPluginIndexing || !pluginRoot) {
    return { changed: false, pluginRoot, promotedPluginRoots: state.promotedPluginRoots };
  }

  const existingIndex = state.promotedPluginRoots.findIndex((root) => root.toLowerCase() === pluginRoot.toLowerCase());
  if (existingIndex !== -1) {
    return { changed: false, pluginRoot, promotedPluginRoots: state.promotedPluginRoots };
  }

  const promotedPluginRoots = [...state.promotedPluginRoots, pluginRoot].slice(-MAX_PROMOTED_PLUGIN_ROOTS);
  await mutateJson(options.tx, projectRoot, pluginIndexStatePath(projectRoot), { version: 1, promotedPluginRoots });
  const stubsPath = path.join(projectRoot, EXTENSION_DATA_DIR, 'UHTIDEStubs.h');
  let existingStubsPath: string | undefined;
  try {
    await fs.promises.access(stubsPath);
    existingStubsPath = stubsPath.replace(/\\/g, '/');
  } catch {
    // A project can open a plugin before bootstrap has generated UHT stubs.
  }
  await ensureClangdConfig(projectRoot, {
    tx: options.tx,
    stubsPath: existingStubsPath,
    lazyPluginIndexing: true,
    promotedPluginRoots,
  });
  return { changed: true, pluginRoot, promotedPluginRoots };
}

export function buildManagedClangdBlock(options: {
  stubsPath?: string;
  intermediateIncludes?: string[];
  lazyPluginIndexing?: boolean;
  promotedPluginRoots?: string[];
}): string {
  const addFlags: string[] = [
    '-Wno-microsoft-template',
    '-Wno-unknown-pragmas',
    '-Wno-unused-value',
    '-Wno-switch',
    '-Wno-invalid-offsetof',
    '-Wno-invalid-constexpr',
    '-Wno-ignored-attributes',
  ];

  if (options.stubsPath) {
    addFlags.push('-include', options.stubsPath);
  }

  // Module/UHT include paths belong to their owning compile_commands entry.
  // Adding every discovered path globally creates 30k+ character commands on
  // large UE projects and makes unrelated headers parse with the wrong module.
  void options.intermediateIncludes;

  const addLines = addFlags.map((f) => `    - ${f}`).join('\n');

  const lines = [
    CLANGD_MANAGED_BEGIN,
    '# UE 5.8 + clangd + UHT IDE stubs (IDE 전용)',
    'CompileFlags:',
    '  CompilationDatabase: .',
    '  Add:',
    addLines,
    '  Remove:',
    '    - -W*',
    // Migration guard: older generated databases translated MSVC /Yu to this
    // clang-only flag with a textual .h path. Never feed an MSVC PCH model to
    // clangd; /FI already supplies the PCH header as a normal forced include.
    '    - -include-pch',
    '    - /Yu*',
    'Index:',
    '  Background: Build',
    'Diagnostics:',
    // Include Cleaner cannot model Unreal's PCH, generated headers, or UHT
    // reflection macros. UBT/IWYU remains the authoritative include checker.
    '  UnusedIncludes: None',
    '  MissingIncludes: None',
    '  ClangTidy:',
    // clang-tidy is opt-in for UE. Running it during interactive parsing is
    // expensive and several checks misclassify UHT/generated declarations.
    '    Remove: "*"',
    'Completion:',
    '  AllScopes: true',
  ];

  if (options.lazyPluginIndexing !== false) {
    // Keep all plugin compile commands available for foreground parsing, but do
    // not make an unopened plugin delay the game's initial project index.
    lines.push(
      '---',
      'If:',
      '  PathMatch: Plugins/.*',
      'Index:',
      '  Background: Skip',
    );
    for (const root of options.promotedPluginRoots ?? []) {
      const normalized = normalizePluginRoot(root);
      if (!normalized) continue;
      lines.push(
        '---',
        'If:',
        `  PathMatch: ${escapePathRegex(normalized)}/.*`,
        'Index:',
        '  Background: Build',
      );
    }
  }

  // Keep every generated YAML document inside the managed range. Otherwise a
  // later promotion would leave stale `Background: Build` fragments behind.
  lines.push(CLANGD_MANAGED_END);

  return lines.join('\n');
}

export async function ensureClangdConfig(
  projectRoot: string,
  options: {
    stubsPath?: string;
    intermediateIncludes?: string[];
    tx?: WorkspaceMutationTransaction;
    lazyPluginIndexing?: boolean;
    promotedPluginRoots?: string[];
  } = {},
): Promise<boolean> {
  const filePath = path.join(projectRoot, '.clangd');
  const state = options.lazyPluginIndexing === false
    ? { version: 1 as const, promotedPluginRoots: [] }
    : await readPluginIndexState(projectRoot);
  const block = buildManagedClangdBlock({
    ...options,
    promotedPluginRoots: options.promotedPluginRoots ?? state.promotedPluginRoots,
  });

  let content = '';
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }

  let beginIdx = content.indexOf(CLANGD_MANAGED_BEGIN);
  let endIdx = content.indexOf(CLANGD_MANAGED_END);
  let endMarker = CLANGD_MANAGED_END;

  if (beginIdx === -1) {
    beginIdx = content.indexOf(LEGACY_CLANGD_MANAGED_BEGIN);
    endIdx = content.indexOf(LEGACY_CLANGD_MANAGED_END);
    endMarker = LEGACY_CLANGD_MANAGED_END;
  }

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = content.slice(0, beginIdx).replace(/\s+$/, '');
    const afterEnd = endIdx + endMarker.length;
    const after = content.slice(afterEnd).replace(/^\s+/, '');
    const pieces = [before, block];
    if (after.length > 0) pieces.push(after);
    const newContent = pieces.join('\n\n') + '\n';
    if (newContent === content) return false;
    await mutateText(options.tx, projectRoot, filePath, newContent);
    return true;
  }

  const trimmed = content.trimEnd();
  const newContent = trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  await mutateText(options.tx, projectRoot, filePath, newContent);
  return true;
}
