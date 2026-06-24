import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', 'schemas', 'ue58-mcp-schema-draft.json');
const ajv = new Ajv({ allErrors: true });

const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf-8')));

describe('ajv MCP schema validation', () => {
  for (const name of ['ue58-mcp-fallback.json', 'ue58-mcp-captured.json']) {
    it(`validates ${name}`, () => {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', name), 'utf-8'));
      const ok = validate(data);
      assert.ok(ok, validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; '));
    });
  }
});
