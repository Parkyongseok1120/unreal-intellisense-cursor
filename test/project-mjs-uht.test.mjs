import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const uhtRunner = loadTsModule('src/uht/uhtRunner.ts');

const projectRoot = process.env.PROJECT_MJS_ROOT
  || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Documents', 'Github', 'Project_MJS');
const uproject = path.join(projectRoot, 'Project_MJS.uproject');
const engineRoot = process.env.UE_ROOT;
const uht = engineRoot ? uhtRunner.resolveUhtExecutable({ root: engineRoot, version: '5.8', source: 'manual' }) : '';
const skipUht = !engineRoot || !fs.existsSync(uproject) || !fs.existsSync(uht);

describe('Project_MJS live UHT smoke', () => {
  it('runs UHT when UE_ROOT and project are available', { skip: skipUht }, () => {
    const result = spawnSync(uht, [uproject, '-run=Compile', '-WarningsAsErrors', '-installed'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }
    assert.equal(result.status, 0, 'UHT compile failed');
  });
});
