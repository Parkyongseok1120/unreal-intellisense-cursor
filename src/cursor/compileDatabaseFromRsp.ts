import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import { generateCompileDatabaseFromBuildCs } from './compileDatabaseFromBuildCs';
import { mutateJson, type WorkspaceMutationTransaction } from '../platform/workspaceMutation';
import {
  findSharedRspFiles,
  normalizeSlash,
  parseObjRspForceIncludes,
  parseSharedRspToClangFlags,
  type RspCompileContext,
} from '../projectModel/rspActionImporter';

export {
  convertMsvcRspLineToClangArgs,
  normalizeSlash,
  parseSharedRspToClangFlags,
  resolveRspIncludePath,
  type RspCompileContext,
} from '../projectModel/rspActionImporter';

export { findSharedRspFiles };

async function findObjRspNear(sharedRsp: string): Promise<string | undefined> {
  const dir = path.dirname(sharedRsp);
  try {
    const entries = await fs.promises.readdir(dir);
    const hit = entries.find((e) => e.startsWith('Module.') && e.endsWith('.cpp.obj.rsp'));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

async function collectCppFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const roots = [path.join(projectRoot, 'Source'), path.join(projectRoot, 'Plugins')];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'Intermediate' || entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.isFile() && /\.(cpp|cc|cxx)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }
  return files;
}

function moduleNameFromRsp(rspPath: string): string {
  return path.basename(rspPath, '.Shared.rsp');
}

export async function generateCompileDatabaseFromRsp(
  projectRoot: string,
  engineRoot: string,
  tx?: WorkspaceMutationTransaction,
): Promise<{ ok: boolean; entryCount: number; rspPath?: string; error?: string }> {
  const rspFiles = await findSharedRspFiles(projectRoot);
  if (rspFiles.length === 0) {
    return {
      ok: false,
      entryCount: 0,
      error: 'Intermediate에 .Shared.rsp가 없습니다. UE 에디터에서 프로젝트를 한 번 빌드하세요.',
    };
  }

  const cppFiles = await collectCppFiles(projectRoot);
  if (cppFiles.length === 0) {
    return { ok: false, entryCount: 0, error: 'Source/*.cpp 파일을 찾지 못했습니다.' };
  }

  const entries: Array<{ directory: string; file: string; command: string }> = [];
  const compiler = 'clang++';

  for (const rspPath of rspFiles) {
    const moduleName = moduleNameFromRsp(rspPath);
    const ctx: RspCompileContext = {
      projectRoot,
      engineRoot,
      engineSource: path.join(engineRoot, 'Engine', 'Source'),
      rspDir: path.dirname(rspPath),
    };
    let flags = parseSharedRspToClangFlags(rspPath, engineRoot, projectRoot);
    const objRsp = await findObjRspNear(rspPath);
    if (objRsp) {
      const seen = new Set<string>();
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '-I' || flags[i] === '-include') seen.add(`${flags[i]}:${flags[i + 1]}`);
      }
      const extras = parseObjRspForceIncludes(objRsp, ctx);
      for (let j = 0; j < extras.length; j += 2) {
        const key = `${extras[j]}:${extras[j + 1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          flags.push(extras[j], extras[j + 1]);
        }
      }
    }
    const flagParts: string[] = [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === '-I' || f === '-include') {
        flagParts.push(`${f} "${flags[++i]}"`);
      } else {
        flagParts.push(f.includes(' ') ? `"${f}"` : f);
      }
    }
    const flagStr = flagParts.join(' ');
    const moduleCpp = cppFiles.filter((f) => {
      const norm = normalizeSlash(f);
      return norm.includes(`/Source/${moduleName}/`) || (norm.includes(`/Plugins/`) && norm.includes(`/${moduleName}/`));
    });

    const targets = moduleCpp.length > 0 ? moduleCpp : cppFiles;
    for (const file of targets) {
      const directory = projectRoot;
      const command = `${compiler} ${flagStr} -c ${normalizeSlash(file)}`;
      entries.push({
        directory: normalizeSlash(directory),
        file: normalizeSlash(file),
        command,
      });
    }
  }

  if (entries.length === 0) {
    return { ok: false, entryCount: 0, error: 'compile_commands 항목을 만들지 못했습니다.' };
  }

  const outPath = path.join(projectRoot, 'compile_commands.json');
  await mutateJson(tx, projectRoot, outPath, entries);
  return { ok: true, entryCount: entries.length, rspPath: rspFiles[0] };
}

export async function tryGenerateCompileDatabase(
  projectRoot: string,
  engineRoot: string,
): Promise<{ ok: boolean; source: 'rsp' | 'ubt' | 'buildcs'; entryCount?: number; error?: string }> {
  if (!(await fileExists(engineRoot))) {
    return { ok: false, source: 'rsp', error: `엔진 경로 없음: ${engineRoot}` };
  }
  const rsp = await generateCompileDatabaseFromRsp(projectRoot, engineRoot);
  if (rsp.ok) {
    return { ok: true, source: 'rsp', entryCount: rsp.entryCount };
  }
  const buildcs = await generateCompileDatabaseFromBuildCs(projectRoot, engineRoot);
  if (buildcs.ok) {
    return { ok: true, source: 'buildcs', entryCount: buildcs.entryCount };
  }
  return { ok: false, source: 'buildcs', error: rsp.error ?? buildcs.error };
}
