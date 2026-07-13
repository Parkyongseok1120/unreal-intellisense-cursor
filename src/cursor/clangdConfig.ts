import * as fs from 'fs';
import * as path from 'path';
import { CLANGD_MANAGED_BEGIN, CLANGD_MANAGED_END, LEGACY_CLANGD_MANAGED_BEGIN, LEGACY_CLANGD_MANAGED_END } from '../constants';
import { mutateText, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';

export function buildManagedClangdBlock(options: {
  stubsPath?: string;
  intermediateIncludes?: string[];
}): string {
  const addFlags: string[] = [
    '-Wno-microsoft-template',
    '-Wno-unknown-pragmas',
    '-Wno-unused-value',
    '-Wno-switch',
    '-Wno-invalid-offsetof',
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

  return [
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
    'Completion:',
    '  AllScopes: true',
    CLANGD_MANAGED_END,
  ].join('\n');
}

export async function ensureClangdConfig(
  projectRoot: string,
  options: { stubsPath?: string; intermediateIncludes?: string[]; tx?: WorkspaceMutationTransaction } = {},
): Promise<boolean> {
  const filePath = path.join(projectRoot, '.clangd');
  const block = buildManagedClangdBlock(options);

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
