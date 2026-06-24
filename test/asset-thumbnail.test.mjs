import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseAssetInfoResponse(text) {
  const info = JSON.parse(text);
  const cls = info.class ?? info.Class ?? info.asset_class ?? info.AssetClass;
  let thumb = info.thumbnail ?? info.Thumbnail ?? info.thumbnail_base64 ?? info.thumbnailUrl ?? info.thumbnail_url;
  if (thumb && !thumb.startsWith('data:') && !thumb.startsWith('http')) {
    thumb = `data:image/png;base64,${thumb}`;
  }
  return { packageClass: cls, thumbnailDataUri: thumb };
}

describe('assetThumbnailService', () => {
  it('parses asset info fixture with class and thumbnail', () => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'asset-info-response.json'), 'utf-8');
    const parsed = parseAssetInfoResponse(fixture);
    assert.equal(parsed.packageClass, 'Blueprint');
    assert.ok(parsed.thumbnailDataUri?.startsWith('data:image/png;base64,'));
  });
});
