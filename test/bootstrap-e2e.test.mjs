import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(__dirname, '..');
const projectRoot = path.resolve(extRoot, '..', 'Project_MJS');
const uprojectPath = path.join(projectRoot, 'Project_MJS.uproject');
const engineRoot = process.env.UE_ENGINE_ROOT ?? 'C:\\Program Files\\Epic Games\\UE_5.8';
const setupScript = path.join(extRoot, 'scripts', 'setup-intellisense.mjs');
const localGameProjectAvailable = fs.existsSync(uprojectPath);

function ensureIntellisenseArtifacts() {
  if (!fs.existsSync(engineRoot)) return;
  if (fs.existsSync(path.join(projectRoot, 'compile_commands.json'))) return;
  execFileSync(
    process.execPath,
    [setupScript, `--project=${projectRoot}`, `--engine=${engineRoot}`],
    { stdio: 'pipe', cwd: extRoot },
  );
}

const describeBootstrap = localGameProjectAvailable ? describe : describe.skip;

describeBootstrap(
  'v6 zero-touch bootstrap artifacts (local game project — optional)',
  () => {
  it('project exists', () => {
    assert.ok(fs.existsSync(uprojectPath));
  });

  it('bootstrap artifacts present after setup-intellisense', () => {
    ensureIntellisenseArtifacts();

    const clangdPath = path.join(projectRoot, '.clangd');
    const settingsPath = path.join(projectRoot, '.vscode', 'settings.json');
    const compileDb = path.join(projectRoot, 'compile_commands.json');

    if (!fs.existsSync(engineRoot)) {
      console.log('skip artifact assert: UE engine not installed');
      return;
    }

    assert.ok(fs.existsSync(clangdPath), '.clangd missing — run setup:intellisense');
    const clangd = fs.readFileSync(clangdPath, 'utf-8');
    assert.ok(clangd.includes('-I') || clangd.includes('CompileFlags'), '.clangd should define includes');

    assert.ok(fs.existsSync(settingsPath), '.vscode/settings.json missing');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(settings['clangd.path'] || settings['clangd.arguments'], 'clangd vscode settings expected');

    if (fs.existsSync(compileDb)) {
      const entries = JSON.parse(fs.readFileSync(compileDb, 'utf-8'));
      assert.ok(Array.isArray(entries) && entries.length > 0, 'compile_commands should have entries');
    }
  });
  },
);

describe('bundled clangd layout', () => {
  it('fetch-llvm output path exists when packaged', () => {
    const bundled = path.join(extRoot, 'bin', 'win32-x64', 'clangd.exe');
    if (!fs.existsSync(bundled)) {
      console.log('skip: run node scripts/fetch-llvm.mjs before package');
      return;
    }
    assert.ok(fs.statSync(bundled).size > 1_000_000, 'clangd.exe should be non-trivial size');
  });
});
