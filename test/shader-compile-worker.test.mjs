import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const shaderWorker = loadTsModule('src/hlsl/shaderCompileWorker.ts');

describe('shader compile worker parser', () => {
  it('maps virtual /Project paths to project shaders', () => {
    const resolved = shaderWorker.resolveVirtualShaderInclude(
      '/Project/Private/MyShader.usf',
      'C:/Game',
      'C:/UE',
    );
    assert.equal(resolved?.replace(/\\/g, '/'), 'C:/Game/Shaders/Private/MyShader.usf');
  });

  it('parses ShaderCompileWorker diagnostic lines', () => {
    const output = 'C:/Game/Shaders/Private/Foo.usf(12,4): error: undeclared identifier';
    const diags = shaderWorker.parseShaderCompileWorkerOutput(output, 'C:/Game');
    assert.equal(diags.length, 1);
    assert.equal(diags[0].line, 12);
    assert.equal(diags[0].severity, 'error');
  });
});
