#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(__dirname, '..');
const extensionTestsPath = path.resolve(__dirname, 'suite-extension');
const distJs = path.join(extensionDevelopmentPath, 'dist', 'extension.js');

async function main() {
  if (!fs.existsSync(distJs)) {
    const msg = '[ext-host] dist/extension.js not built';
    if (process.env.CI === 'true') {
      console.error(msg);
      process.exit(1);
    }
    console.log(`${msg} — skipping`);
    process.exit(0);
  }

  let testElectron;
  try {
    testElectron = await import('@vscode/test-electron');
  } catch (err) {
    console.error('[ext-host] @vscode/test-electron not available', err);
    process.exit(process.env.CI === 'true' ? 1 : 0);
  }

  const fixture = path.resolve(extensionDevelopmentPath, 'test', 'fixtures', 'synthetic-ue-project');
  const launchArgs = [fixture];

  try {
    await testElectron.runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
    console.log('[ext-host] OK');
  } catch (err) {
    console.error('[ext-host] failed', err);
    process.exit(1);
  }
}

main();
