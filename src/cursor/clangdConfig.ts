import * as fs from 'fs';
import * as path from 'path';
import { CLANGD_MANAGED_BEGIN, CLANGD_MANAGED_END, LEGACY_CLANGD_MANAGED_BEGIN, LEGACY_CLANGD_MANAGED_END } from '../constants';

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

  const seenIncludes = new Set<string>();
  for (const inc of options.intermediateIncludes ?? []) {
    const normalized = path.normalize(inc).replace(/\\/g, '/').toLowerCase();
    if (seenIncludes.has(normalized)) continue;
    seenIncludes.add(normalized);
    addFlags.push('-I', inc.replace(/\\/g, '/'));
  }

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
    'Index:',
    '  Background: Build',
    'Diagnostics:',
    '  Suppress:',
    '    - unknown_typename',
    '    - err_unknown_typename',
    '    - pp_file_not_found',
    '    - member_function_call_bad_type',
    '    - ovl_no_viable_member_function_in_call',
    'Completion:',
    '  AllScopes: true',
    CLANGD_MANAGED_END,
  ].join('\n');
}

export async function ensureClangdConfig(
  projectRoot: string,
  options: { stubsPath?: string; intermediateIncludes?: string[] } = {},
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
    await fs.promises.writeFile(filePath, newContent, 'utf-8');
    return true;
  }

  const trimmed = content.trimEnd();
  const newContent = trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  await fs.promises.writeFile(filePath, newContent, 'utf-8');
  return true;
}
