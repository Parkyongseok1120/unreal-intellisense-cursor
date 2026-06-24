import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const mcpOptions = {
  entryPoints: ['src/mcp/server.ts'],
  bundle: true,
  outfile: 'dist/mcp-server.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

async function main() {
  if (isWatch) {
    const ctx1 = await esbuild.context(extensionOptions);
    const ctx2 = await esbuild.context(mcpOptions);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log('[UE5_8 Cursor] Watching...');
  } else {
    await Promise.all([esbuild.build(extensionOptions), esbuild.build(mcpOptions)]);
    console.log('[UE5_8 Cursor] Build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
