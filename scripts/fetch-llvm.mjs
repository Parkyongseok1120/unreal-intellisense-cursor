#!/usr/bin/env node
/**
 * Fetch LLVM clangd for bundling into VSIX (win32-x64).
 * Usage: node scripts/fetch-llvm.mjs [--version=19.1.0]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERSION = (process.argv.find((a) => a.startsWith('--version='))?.split('=')[1]) ?? '19.1.0';
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
  const resourceDestParent = path.join(ROOT, 'bin', 'lib', 'clang');
  await fs.promises.mkdir(resourceDestParent, { recursive: true });
  const majors = (await fs.promises.readdir(resourceSrcParent, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );
  for (const major of majors) {
    // Only the builtin headers (lib/clang/<major>/include) are needed for clangd
    // IntelliSense. The compiler-rt libs and share/ would add ~33 MB for nothing.
    const src = path.join(resourceSrcParent, major.name, 'include');
    const dst = path.join(resourceDestParent, major.name, 'include');
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(path.join(dst, 'stddef.h'))) {
      log(`resource dir already bundled: ${dst}`);
      continue;
    }
    log(`Copying clang resource headers ${major.name}...`);
    await fs.promises.cp(src, dst, { recursive: true });
  }
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  const clangdDest = path.join(OUT_DIR, 'clangd.exe');
  const resourceBundled = fs.existsSync(path.join(ROOT, 'bin', 'lib', 'clang'));
  if (fs.existsSync(clangdDest) && resourceBundled) {
    log(`clangd already exists: ${clangdDest}`);
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
    const nested = await findClangdInTree(extractDir);
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
  for (const dll of ['libclang.dll', 'libomp.dll']) {
    const src = path.join(binDir, dll);
    if (fs.existsSync(src)) {
      await fs.promises.copyFile(src, path.join(OUT_DIR, dll));
      log(`Copied ${dll}`);
    }
  }

  await ensureResourceDir(binDir);

  log(`Bundled clangd: ${clangdDest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
