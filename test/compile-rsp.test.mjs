import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function loadRspParser() {
  return loadTsModule('src/cursor/compileDatabaseFromRsp.ts', {
    '../platform/paths': () => ({ fileExists: async () => false }),
    './compileDatabaseFromBuildCs': () => ({
      generateCompileDatabaseFromBuildCs: async () => ({ ok: false }),
    }),
    '../platform/workspaceMutation': () => ({
      mutateJson: async (_tx, _projectRoot, filePath, value) => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
      },
    }),
  });
}

describe('parseSharedRspToClangFlags', () => {
  it('never assigns a plugin source to a same-named project module', async () => {
    const { generateCompileDatabaseFromRsp, moduleNameFromProjectSource } = loadRspParser();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-owner-'));
    const projectRoot = path.join(root, 'Project_MJS');
    const engineRoot = path.join(root, 'UE_5.8');
    const projectSource = path.join(projectRoot, 'Source', 'Project_MJS', 'Private', 'Main.cpp');
    const pluginSource = path.join(projectRoot, 'Plugins', 'AudioPlugin', 'Source', 'AudioPlugin', 'Private', 'Audio.cpp');
    const rspDir = path.join(projectRoot, 'Intermediate', 'Build', 'Win64', 'x64', 'UnrealEditor', 'Development', 'Project_MJS');
    fs.mkdirSync(path.dirname(projectSource), { recursive: true });
    fs.mkdirSync(path.dirname(pluginSource), { recursive: true });
    fs.mkdirSync(rspDir, { recursive: true });
    fs.writeFileSync(projectSource, '// project');
    fs.writeFileSync(pluginSource, '// plugin');
    fs.writeFileSync(path.join(rspDir, 'Project_MJS.Shared.rsp'), `/I "${path.dirname(projectSource)}"`);

    assert.equal(moduleNameFromProjectSource(projectSource, projectRoot), 'Project_MJS');
    assert.equal(moduleNameFromProjectSource(pluginSource, projectRoot), 'AudioPlugin');
    const result = await generateCompileDatabaseFromRsp(projectRoot, engineRoot);
    assert.equal(result.ok, true);
    const entries = JSON.parse(fs.readFileSync(path.join(projectRoot, 'compile_commands.json'), 'utf-8'));
    assert.equal(entries.length, 1);
    assert.match(entries[0].file.replace(/\\/g, '/'), /Source\/Project_MJS\/Private\/Main\.cpp$/);
  });

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

  it('does not translate MSVC /Yu into clang -include-pch', async () => {
    const { generateCompileDatabaseFromRsp } = loadRspParser();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-pch-'));
    const projectRoot = path.join(root, 'Project');
    const engineRoot = path.join(root, 'UE_5.8');
    const sourceDir = path.join(projectRoot, 'Source', 'Project', 'Private');
    const rspDir = path.join(projectRoot, 'Intermediate', 'Build', 'Win64', 'x64', 'UnrealEditor', 'Development', 'Project');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(rspDir, { recursive: true });

    const cppPath = path.join(sourceDir, 'PchUser.cpp');
    const pchHeader = path.join(rspDir, 'SharedPCH.Project.Cpp20.h');
    const rspPath = path.join(rspDir, 'Project.Shared.rsp');
    const objRspPath = path.join(rspDir, 'Module.Project.cpp.obj.rsp');
    fs.writeFileSync(cppPath, '#include "PchUser.h"\n');
    fs.writeFileSync(rspPath, `/I "${sourceDir}"`);
    fs.writeFileSync(
      objRspPath,
      [`@"${rspPath.replace(/\\/g, '/')}"`, `/FI"${pchHeader.replace(/\\/g, '/')}"`, `/Yu"${pchHeader.replace(/\\/g, '/')}"`].join('\n'),
    );

    const result = await generateCompileDatabaseFromRsp(projectRoot, engineRoot);
    assert.equal(result.ok, true);
    const [entry] = JSON.parse(fs.readFileSync(path.join(projectRoot, 'compile_commands.json'), 'utf-8'));
    assert.ok(entry.command.includes('-include'), 'textual PCH header should remain force-included');
    assert.equal(entry.command.includes('-include-pch'), false, 'MSVC /Yu must not become clang -include-pch');
  });
});
