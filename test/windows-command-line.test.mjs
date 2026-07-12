import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const parser = loadTsModule('src/projectModel/windowsCommandLine.ts');
const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../parsers/moduleLayout': () => ({ discoverModuleLayouts: async () => [] }),
  '../platform/paths': () => ({ fileExists: async (p) => fs.existsSync(p) }),
  '../platform/workspaceMutation': () => ({ mutateJson: async () => {} }),
  '../uht/reflectionIndex': () => ({ buildReflectionIndex: async () => [] }),
  '../uht/uhtRunner': () => ({ findUhtManifest: async () => undefined, parseUhtManifestInputFiles: async () => [] }),
  '../platform/dataDir': () => ({ ensureDataDir: async (root) => path.join(root, '.ue5_8cursor') }),
});

describe('Windows compile command parsing', () => {
  it('preserves quoted Unicode paths and escaped quotes', () => {
    const args = parser.parseWindowsCommandLine('cl.exe /I"C:\\UE Projects\\한글 Include" /DNAME="a b" "Source\\모듈\\Foo.cpp" /DQUOTE=\\"ok\\"');
    assert.deepEqual([...args], ['cl.exe', '/IC:\\UE Projects\\한글 Include', '/DNAME=a b', 'Source\\모듈\\Foo.cpp', '/DQUOTE="ok"']);
  });

  it('preserves compile database working directory for relative source files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-command-'));
    const directory = path.join(root, '작업 공간');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([
      { directory, file: 'Source/모듈/Foo.cpp', command: 'cl.exe /I"C:\\UE Projects\\Include Dir" "Source/모듈/Foo.cpp"' },
    ]) + '\n');
    const [action] = await projectModel.collectCompileActionsFromProject(root);
    assert.equal(action.directory, directory);
    assert.ok(action.file.endsWith('/작업 공간/source/모듈/foo.cpp'));
    assert.deepEqual([...action.arguments], ['cl.exe', '/IC:\\UE Projects\\Include Dir', 'Source/모듈/Foo.cpp']);
  });
});
