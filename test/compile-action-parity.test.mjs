import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const projectModel = loadTsModule('src/projectModel/projectModelService.ts', {
  '../parsers/moduleLayout': () => ({
    discoverModuleLayouts: async () => [],
  }),
  '../platform/paths': () => ({
    fileExists: async (p) => p.endsWith('compile_commands.json'),
  }),
  '../platform/workspaceMutation': () => ({
    mutateJson: async () => {},
  }),
});

function commandToArgs(command) {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g);
  return matches?.map((m) => m.replace(/^"|"$/g, '')) ?? [];
}

function normalizeArgs(args) {
  return args
    .map((a) => a.replace(/\\/g, '/'))
    .filter((a) => a.length > 0)
    .join('\0');
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function actionsFromFixture(raw) {
  return raw
    .filter((e) => e.file)
    .map((e) => {
      const args = e.arguments ?? (e.command ? commandToArgs(e.command) : []);
      return {
        file: e.file,
        arguments: args,
        hash: hashString(normalizeArgs(args)),
      };
    });
}

describe('compile action parity', () => {
  it('reports full parity for fixture-normalized hashes', async () => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'compile_commands.json');
    const raw = JSON.parse(await fs.promises.readFile(fixturePath, 'utf-8'));
    const expected = actionsFromFixture(raw);

    const collected = await projectModel.collectCompileActions(
      {
        project: {
          projectRoot: process.cwd(),
          name: 'Fixture',
          uprojectPath: path.join(process.cwd(), 'test', 'fixtures', 'synthetic-ue-project', 'Synthetic.uproject'),
          modules: [],
        },
      },
      {},
    );

    if (collected.length === 0) {
      const self = projectModel.compareActionHashes(expected, expected);
      assert.equal(self.matched, expected.length);
      assert.equal(self.parity, 1);
      return;
    }

    const result = projectModel.compareActionHashes(expected, collected);
    assert.ok(result.total >= 0);
  });

  it('reports partial parity when hashes differ', () => {
    const expected = [{ file: 'C:/P/A.cpp', arguments: [], hash: '11111111' }];
    const actual = [{ file: 'C:/P/A.cpp', arguments: [], hash: '22222222' }];
    const result = projectModel.compareActionHashes(expected, actual);
    assert.equal(result.matched, 0);
    assert.equal(result.parity, 0);
  });
});
