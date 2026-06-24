/** .gitignore에 추가할 UE5_8 Cursor 생성물 (커밋 금지) */
export const GITIGNORE_MARKER = '# UE5_8 Cursor — plugin-generated, do not commit';

export const GENERATED_GITIGNORE_LINES = [
  GITIGNORE_MARKER,
  '.vscode/',
  '.cursor/',
  'compile_commands.json',
  '.clangd',
  '.clang-format',
  '.ue5_8cursor/',
  '.ue58rider/',
] as const;

export const GENERATED_SETTINGS_FLAG = 'ue58rider.generated';
