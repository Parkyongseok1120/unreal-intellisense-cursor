import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(__dirname, '..');
const projectRoot = path.resolve(extRoot, '..', 'Project_MJS');
const uprojectPath = path.join(projectRoot, 'Project_MJS.uproject');
const mcpJsonPath = path.join(projectRoot, '.cursor', 'mcp.json');
const dataDir = path.join(projectRoot, '.ue5_8cursor');
const localGameProjectAvailable = fs.existsSync(uprojectPath);

describe.skipIf(!localGameProjectAvailable)('local game project integration (optional)', () => {
  it('has .uproject with MCP plugins', () => {
    assert.ok(fs.existsSync(uprojectPath), 'Project_MJS.uproject missing');
    const data = JSON.parse(fs.readFileSync(uprojectPath, 'utf-8'));
    const plugins = data.Plugins ?? [];
    for (const name of ['ModelContextProtocol', 'AllToolsets']) {
      const entry = plugins.find((p) => p.Name === name);
      assert.ok(entry?.Enabled, `${name} not enabled`);
    }
  });

  it('has .cursor/mcp.json pointing to port 8000', () => {
    assert.ok(fs.existsSync(mcpJsonPath), '.cursor/mcp.json missing');
    const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    const url = cfg.mcpServers?.['unreal-engine-58']?.url ?? '';
    assert.ok(url.includes('8000'), `expected port 8000 in mcp url, got ${url}`);
  });

  it('has .ue5_8cursor data directory', () => {
    assert.ok(fs.existsSync(dataDir), '.ue5_8cursor missing');
  });

  it('asset index has entries when Content is present', () => {
    const indexPath = path.join(dataDir, 'asset-index.json');
    if (!fs.existsSync(indexPath)) return;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    assert.ok(Array.isArray(index.entries));
    if (index.entries.length > 0) {
      assert.ok(index.entries[0].assetPath.startsWith('/Game/'));
    }
  });
});

describe('ReferenceProvider prerequisites', () => {
  it('asset path parser finds TEXT macro paths', () => {
    const sample = 'LoadObject<UMesh>(nullptr, TEXT("/Game/Characters/BP_Hero.BP_Hero"));';
    const re = /TEXT\s*\(\s*"(\/Game\/[^"]+)"\s*\)/;
    const m = sample.match(re);
    assert.ok(m);
    assert.equal(m[1], '/Game/Characters/BP_Hero.BP_Hero');
  });
});
