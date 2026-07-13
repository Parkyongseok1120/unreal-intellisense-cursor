#!/usr/bin/env node
/**
 * Fetch the minimal LLVM toolchain needed by clangd and UBT's
 * GenerateClangDatabase mode for bundling into VSIX (win32-x64).
 * Usage: node scripts/fetch-llvm.mjs [--version=20.1.8]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERSION = (process.argv.find((a) => a.startsWith('--version='))?.split('=')[1]) ?? '20.1.8';
const OUT_DIR = path.join(ROOT, 'bin', 'win32-x64');

const LLVM_TAG = `llvmorg-${VERSION}`;
const ARCHIVE_CANDIDATES = [
  `https://github.com/llvm/llvm-project/releases/download/${LLVM_TAG}/clang+llvm-${VERSION}-x86_64-pc-windows-msvc.tar.xz`,
  `https://github.com/llvm/llvm-project/releases/download/${LLVM_TAG}/LLVM-${VERSION}-Windows-X64.tar.xz`,
];

function log(msg) {
  console.log(`[fetch-llvm] ${msg}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', reject);
  });
}

async function findClangdInTree(dir) {
  const direct = path.join(dir, 'bin', 'clangd.exe');
  if (fs.existsSync(direct)) return direct;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findClangdInTree(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Copy clang's builtin-header resource dir (lib/clang/<major>) so the bundled
 * clangd can resolve <stddef.h>, intrinsics (immintrin.h, ...) and other builtins.
 * Placed at bin/lib/clang/<major> so that the bundled clangd at
 * bin/win32-x64/clangd.exe auto-detects it via ../lib/clang/<major>.
 */
async function ensureResourceDir(llvmBinDir) {
  const llvmRoot = path.dirname(llvmBinDir);
  const resourceSrcParent = path.join(llvmRoot, 'lib', 'clang');
  if (!fs.existsSync(resourceSrcParent)) {
    log(`WARNING: resource dir not found at ${resourceSrcParent}; clangd builtins may be missing`);
    return;
  }
  const resourceDestParents = [
    path.join(ROOT, 'bin', 'lib', 'clang'),
    path.join(OUT_DIR, 'lib', 'clang'),
  ];
  await Promise.all(resourceDestParents.map((dest) => fs.promises.mkdir(dest, { recursive: true })));
  const majors = (await fs.promises.readdir(resourceSrcParent, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );
  for (const major of majors) {
    // Only the builtin headers (lib/clang/<major>/include) are needed for clangd
    // IntelliSense. The compiler-rt libs and share/ would add ~33 MB for nothing.
    const src = path.join(resourceSrcParent, major.name, 'include');
    if (!fs.existsSync(src)) continue;
    for (const resourceDestParent of resourceDestParents) {
      const dst = path.join(resourceDestParent, major.name, 'include');
      if (fs.existsSync(path.join(dst, 'stddef.h'))) {
        log(`resource dir already bundled: ${dst}`);
        continue;
      }
      log(`Copying clang resource headers ${major.name}...`);
      await fs.promises.cp(src, dst, { recursive: true });
    }
  }
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  const clangdDest = path.join(OUT_DIR, 'clangd.exe');
  const compilerBinDir = path.join(OUT_DIR, 'bin');
  const clangCompilerDest = path.join(compilerBinDir, 'clang++.exe');
  const versionMarker = path.join(OUT_DIR, '.llvm-version');
  for (const tool of ['clang++.exe', 'clang.exe', 'clang-cl.exe']) {
    await fs.promises.rm(path.join(OUT_DIR, tool), { force: true });
  }
  const resourceBundled = fs.existsSync(path.join(ROOT, 'bin', 'lib', 'clang'));
  const bundledVersion = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf8').trim() : '';
  if (fs.existsSync(clangdDest) && fs.existsSync(clangCompilerDest) && resourceBundled && bundledVersion === VERSION) {
    log(`LLVM tools already exist: ${clangdDest}`);
    log('resource dir already bundled.');
    return;
  }

  const cacheDir = path.join(ROOT, '.llvm-cache');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, `clang+llvm-${VERSION}-win64.tar.xz`);
  const extractDir = path.join(cacheDir, `extract-${VERSION}`);

  if (!fs.existsSync(archivePath)) {
    let lastErr;
    for (const url of ARCHIVE_CANDIDATES) {
      try {
        log(`Downloading ${url}`);
        await download(url, archivePath);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      }
    }
    if (lastErr) throw lastErr;
  }

  if (!fs.existsSync(path.join(extractDir, 'bin', 'clangd.exe'))) {
    // A fresh cache has no extract directory yet. Do not attempt a recursive
    // scan before creating it; that turned a successful download into ENOENT
    // and made VSIX packaging fail on first use.
    const nested = fs.existsSync(extractDir) ? await findClangdInTree(extractDir) : undefined;
    if (!nested) {
      log('Extracting LLVM archive...');
      await fs.promises.mkdir(extractDir, { recursive: true });
      execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { stdio: 'inherit' });
    }
  }

  const clangdSrc = await findClangdInTree(extractDir);
  if (!clangdSrc) {
    throw new Error(`clangd.exe not found after extract. Check ${extractDir}`);
  }

  const binDir = path.dirname(clangdSrc);
  await fs.promises.copyFile(clangdSrc, clangdDest);
  await fs.promises.mkdir(compilerBinDir, { recursive: true });
  // clangd alone is insufficient: UBT's GenerateClangDatabase validates a
  // real x64 compiler. Keep the companion drivers beside clangd so a fresh
  // computer can produce an authoritative database without a global LLVM.
  for (const tool of ['clang++.exe', 'clang.exe', 'clang-cl.exe']) {
    const src = path.join(binDir, tool);
    if (fs.existsSync(src)) {
      await fs.promises.copyFile(src, path.join(compilerBinDir, tool));
      log(`Copied ${tool}`);
    }
  }

  if (bundledVersion !== VERSION) {
    await fs.promises.rm(path.join(ROOT, 'bin', 'lib', 'clang'), { recursive: true, force: true });
    await fs.promises.rm(path.join(OUT_DIR, 'lib', 'clang'), { recursive: true, force: true });
  }
  for (const dll of ['libclang.dll', 'libclang-cpp.dll', 'libomp.dll']) {
    const src = path.join(binDir, dll);
    if (fs.existsSync(src)) {
      await fs.promises.copyFile(src, path.join(OUT_DIR, dll));
      log(`Copied ${dll}`);
    }
  }

  await ensureResourceDir(binDir);
  await fs.promises.writeFile(versionMarker, `${VERSION}\n`, 'utf8');

  log(`Bundled clangd: ${clangdDest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
