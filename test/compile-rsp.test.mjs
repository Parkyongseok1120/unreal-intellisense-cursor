import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadRspParser() {
  const ts = require('typescript');
  const sourcePath = path.join(process.cwd(), 'src', 'cursor', 'compileDatabaseFromRsp.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (id) => {
      if (id === 'fs' || id === 'path') return require(id);
      if (id === '../platform/paths') return { fileExists: () => false };
      if (id === './compileDatabaseFromBuildCs') {
        return { generateCompileDatabaseFromBuildCs: async () => ({ mode: 'missing' }) };
      }
      if (id === '../platform/workspaceMutation') {
        const nodeFs = require('fs');
        const nodePath = require('path');
        return {
          mutateJson: async (_tx, _projectRoot, filePath, value) => {
            await nodeFs.promises.mkdir(nodePath.dirname(filePath), { recursive: true });
            await nodeFs.promises.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
          },
        };
      }
      return require(id);
    },
  };
  vm.runInNewContext(js, sandbox, { filename: sourcePath });
  return module.exports;
}

describe('parseSharedRspToClangFlags', () => {
  it('keeps include paths paired with -I instead of adding bare path arguments', () => {
    const { parseSharedRspToClangFlags } = loadRspParser();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-rsp-'));
    const projectRoot = path.join(root, 'Project');
    const engineRoot = path.join(root, 'UE_5.8');
    const rspDir = path.join(
      projectRoot,
      'Intermediate',
      'Build',
      'Win64',
      'x64',
      'UnrealEditor',
      'Development',
      'Project',
    );
    fs.mkdirSync(rspDir, { recursive: true });

    const privateInclude = path.join(projectRoot, 'Source', 'Project', 'Private');
    const forceInclude = path.join(rspDir, 'Definitions.Project.h');
    const rspPath = path.join(rspDir, 'Project.Shared.rsp');
    fs.writeFileSync(
      rspPath,
      [
        '/DPLATFORM_EXCEPTIONS_DISABLED=0',
        '/I "."',
        `/I "${privateInclude}"`,
        '/I "Runtime/Core/Public"',
        `/FI"${forceInclude}"`,
      ].join('\n'),
    );

    const flags = parseSharedRspToClangFlags(rspPath, engineRoot, projectRoot);
    const normalizedPrivate = privateInclude.replace(/\\/g, '/');
    const privateIndex = flags.indexOf(normalizedPrivate);

    assert.ok(privateIndex > 0, 'private include should be present');
    assert.equal(flags[privateIndex - 1], '-I', 'private include must be paired with -I');
    assert.equal(
      flags.findIndex((flag, index) => flag === normalizedPrivate && flags[index - 1] !== '-I'),
      -1,
      'private include must not appear as a bare compiler argument',
    );
    assert.equal(
      flags.findIndex((flag, index) => flag.endsWith('/Runtime/Core/Public') && flags[index - 1] !== '-I'),
      -1,
      'engine include must not appear as a bare compiler argument',
    );
  });

  it('adds obj rsp force-includes such as UBT Definitions headers to generated compile commands', async () => {
    const { generateCompileDatabaseFromRsp } = loadRspParser();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-cdb-'));
    const projectRoot = path.join(root, 'Project');
    const engineRoot = path.join(root, 'UE_5.8');
    const sourceDir = path.join(projectRoot, 'Source', 'Project', 'Private');
    const rspDir = path.join(
      projectRoot,
      'Intermediate',
      'Build',
      'Win64',
      'x64',
      'UnrealEditor',
      'Development',
      'Project',
    );
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(rspDir, { recursive: true });

    const cppPath = path.join(sourceDir, 'Foo.cpp');
    const definitionsPath = path.join(rspDir, 'Definitions.Project.h');
    const rspPath = path.join(rspDir, 'Project.Shared.rsp');
    const objRspPath = path.join(rspDir, 'Module.Project.cpp.obj.rsp');
    fs.writeFileSync(cppPath, '#include "Foo.h"\n');
    fs.writeFileSync(
      rspPath,
      ['/DPLATFORM_EXCEPTIONS_DISABLED=0', `/I "${sourceDir}"`, '/I "Runtime/Core/Public"'].join('\n'),
    );
    fs.writeFileSync(
      objRspPath,
      [`@"${rspPath.replace(/\\/g, '/')}"`, `/FI"${definitionsPath.replace(/\\/g, '/')}"`].join('\n'),
    );

    const result = await generateCompileDatabaseFromRsp(projectRoot, engineRoot);
    assert.equal(result.ok, true);

    const entries = JSON.parse(fs.readFileSync(path.join(projectRoot, 'compile_commands.json'), 'utf-8'));
    assert.equal(entries.length, 1);
    const command = entries[0].command;
    const normalizedDefinitions = definitionsPath.replace(/\\/g, '/');
    const normalizedSource = sourceDir.replace(/\\/g, '/');

    assert.ok(command.includes(`-include "${normalizedDefinitions}"`), 'Definitions header should be force-included');
    assert.equal(
      command.includes(`-DPLATFORM_EXCEPTIONS_DISABLED=0 ${normalizedSource}`),
      false,
      'include path should not appear as a bare compiler argument',
    );
  });
});
