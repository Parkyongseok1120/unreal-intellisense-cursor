import * as path from 'path';
import * as vscode from 'vscode';
import type { HeaderCompileContext } from '../projectModel/headerCompileContext';

interface ClangdClientLike {
  sendNotification(method: string, params: unknown): Promise<void> | void;
}

interface ClangdExtensionApi {
  getApi(version: number): { languageClient?: ClangdClientLike };
}

interface DynamicCompileCommand {
  workingDirectory: string;
  compilationCommand: string[];
}

const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
const MAX_DYNAMIC_HEADER_CONTEXTS = 64;
const dynamicCommandsByProject = new Map<string, Map<string, DynamicCompileCommand>>();

/**
 * Applies a known module TU command to a directly opened header through
 * clangd's documented `compilationDatabaseChanges` protocol extension. This
 * avoids changing compile_commands.json or restarting clangd per header.
 */
export async function applyAuthoritativeHeaderCompileContext(
  projectRoot: string,
  context: HeaderCompileContext,
): Promise<{ applied: boolean; reason?: string }> {
  if (
    context.provenance !== 'authoritative-module-tu' ||
    !context.workingDirectory ||
    !context.compilationCommand
  ) {
    return { applied: false, reason: context.reason };
  }

  const clangdExtension = vscode.extensions.getExtension<ClangdExtensionApi>(CLANGD_EXTENSION_ID);
  if (!clangdExtension) return { applied: false, reason: 'The vscode-clangd extension API is unavailable.' };
  const exported = clangdExtension.isActive ? clangdExtension.exports : await clangdExtension.activate();
  const client = exported.getApi?.(1)?.languageClient;
  if (!client?.sendNotification) return { applied: false, reason: 'The active vscode-clangd client does not expose its protocol API.' };

  const key = path.resolve(projectRoot).toLowerCase();
  const projectCommands = dynamicCommandsByProject.get(key) ?? new Map<string, DynamicCompileCommand>();
  const headerKey = path.resolve(context.headerPath);
  projectCommands.set(headerKey, {
    workingDirectory: context.workingDirectory,
    compilationCommand: context.compilationCommand,
  });
  trimDynamicHeaderContexts(projectCommands);
  dynamicCommandsByProject.set(key, projectCommands);

  const compilationDatabaseChanges = Object.fromEntries(projectCommands);
  try {
    await client.sendNotification('workspace/didChangeConfiguration', {
      settings: { compilationDatabaseChanges },
    });
    return { applied: true };
  } catch (error) {
    projectCommands.delete(path.resolve(context.headerPath));
    if (projectCommands.size === 0) dynamicCommandsByProject.delete(key);
    return { applied: false, reason: `clangd rejected the header compile context: ${String(error)}` };
  }
}

export function clearAuthoritativeHeaderCompileContexts(projectRoot?: string): void {
  if (!projectRoot) {
    dynamicCommandsByProject.clear();
    return;
  }
  dynamicCommandsByProject.delete(path.resolve(projectRoot).toLowerCase());
}

function trimDynamicHeaderContexts(projectCommands: Map<string, DynamicCompileCommand>): void {
  if (projectCommands.size <= MAX_DYNAMIC_HEADER_CONTEXTS) return;
  const excess = projectCommands.size - MAX_DYNAMIC_HEADER_CONTEXTS;
  const keys = [...projectCommands.keys()];
  for (let i = 0; i < excess; i++) projectCommands.delete(keys[i]);
}
