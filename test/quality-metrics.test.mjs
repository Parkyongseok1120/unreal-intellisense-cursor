import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const baseline = path.join(root, 'test', 'fixtures', 'quality-metrics', 'ci-baseline.json');

describe('quality metrics', () => {
  it('ci-baseline artifact exists with version 1', () => {
    assert.ok(fs.existsSync(baseline));
    const m = JSON.parse(fs.readFileSync(baseline, 'utf-8'));
    assert.equal(m.version, 1);
    assert.ok(m.areas.trust);
  });

  it('release scorecard reads artifact not string probes', () => {
    const src = fs.readFileSync(path.join(root, 'scripts', 'release-scorecard.mjs'), 'utf-8');
    assert.ok(!src.includes('probe() ? area.min'));
    assert.ok(src.includes('loadMetrics'));
  });

  it('collect-quality-metrics writes to an explicit output path', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-quality-')), 'metrics.json');
    const r = spawnSync(process.execPath, ['scripts/collect-quality-metrics.mjs'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, QUALITY_METRICS_PATH: out },
    });
    assert.equal(r.status, 0, r.stderr?.toString());
    assert.ok(fs.existsSync(out));
  });
});
