#!/usr/bin/env node
/**
 * Standalone IntelliSense setup (no VS Code required).
 * Usage: node scripts/setup-intellisense.mjs [--project=PATH] [--engine=PATH]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const PROJECT_ROOT = path.resolve(
  argValue('project', process.env.PROJECT_MJS_ROOT ?? path.join(EXT_ROOT, '..', 'Project_MJS')),
);
const ENGINE_ROOT = path.resolve(
  argValue('engine', process.env.UE_ENGINE_ROOT ?? 'C:/Program Files/Epic Games/UE_5.8'),
);

const CLANGD_BEGIN = '# <<< ue5_8cursor-managed >>>';
const CLANGD_END = '# <<< end-ue5_8cursor-managed >>>';

function log(msg) {
  console.log(`[setup-intellisense] ${msg}`);
}

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function resolveInclude(raw, ctx) {
  const trimmed = raw.replace(/^"|"$/g, '').trim();
  if (!trimmed || trimmed === '.') return ctx.rspDir;
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  for (const prefix of ['Runtime/', 'Developer/', 'Editor/', 'Programs/', 'ThirdParty/']) {
    if (trimmed.startsWith(prefix)) return path.join(ctx.engineSource, trimmed);
  }
  const idx = trimmed.indexOf('Intermediate');
  if (idx >= 0) return path.join(ctx.projectRoot, trimmed.slice(idx));
  const fromRsp = path.resolve(ctx.rspDir, trimmed);
  if (fs.existsSync(fromRsp)) return fromRsp;
  const fromEngine = path.join(ctx.engineSource, trimmed);
  if (fs.existsSync(fromEngine)) return fromEngine;
  return fromRsp;
}

function parseRsp(rspPath) {
  const content = fs.readFileSync(rspPath, 'utf-8');
  const ctx = {
    projectRoot: PROJECT_ROOT,
    engineSource: path.join(ENGINE_ROOT, 'Engine', 'Source'),
    rspDir: path.dirname(rspPath),
  };
  const flags = ['-std=c++20', '-fms-compatibility', '-fms-extensions', '-Wno-unknown-pragmas'];
  const seen = new Set();
  const paired = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('@')) continue;
    let out = [];
    const im = t.match(/^\/I\s+(.+)$/i);
    if (im) {
      const resolved = resolveInclude(im[1], ctx);
      const norm = normalize(resolved);
      if (im[1].trim() === '.' || norm.endsWith('/Development/Project_MJS')) continue;
      out = ['-I', norm];
    } else if (/^\/D[A-Za-z_]/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        flags.push(`-D${t.slice(2)}`);
      }
    } else if (/^\/FI/i.test(t)) {
      const inc = t.slice(3).replace(/^"|"$/g, '');
      out = ['-include', normalize(path.isAbsolute(inc) ? inc : path.resolve(ctx.rspDir, inc))];
    } else if (/^\/std:c\+\+(\d+)$/i.test(t)) {
      flags[0] = `-std=c++${t.match(/\d+/)[0]}`;
    }
    if (out.length === 2) {
      const key = `${out[0]}:${out[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        paired.push(out[0], out[1]);
      }
    }
  }
  return [...flags, ...paired];
}

function parseObjRspForceIncludes(objRspPath) {
  const ctx = {
    projectRoot: PROJECT_ROOT,
    engineSource: path.join(ENGINE_ROOT, 'Engine', 'Source'),
    rspDir: path.dirname(objRspPath),
  };
  const flags = [];
  const content = fs.readFileSync(objRspPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^\/FI/i.test(t)) continue;
    const inc = t.slice(3).replace(/^"|"$/g, '');
    flags.push('-include', normalize(path.isAbsolute(inc) ? inc : path.resolve(ctx.rspDir, inc)));
  }
  return flags;
}

async function findObjRspNear(sharedRsp) {
  const dir = path.dirname(sharedRsp);
  try {
    const entries = await fs.promises.readdir(dir);
    const hit = entries.find((e) => e.startsWith('Module.') && e.endsWith('.cpp.obj.rsp'));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

function appendPairedFlags(flags, extras) {
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '-I' || flags[i] === '-include') {
      seen.add(`${flags[i]}:${flags[i + 1]}`);
    }
  }
  for (let i = 0; i < extras.length; i += 2) {
    const key = `${extras[i]}:${extras[i + 1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push(extras[i], extras[i + 1]);
  }
}

async function findRsp() {
  const base = path.join(PROJECT_ROOT, 'Intermediate', 'Build');
  const out = [];
  async function walk(dir, depth) {
    if (depth <= 0) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.Shared.rsp')) out.push(full);
      else if (e.isDirectory()) await walk(full, depth - 1);
    }
  }
  await walk(base, 10);
  return out;
}

async function collectCpp() {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Intermediate') continue;
        await walk(full);
      } else if (/\.(cpp|cc|cxx)$/i.test(e.name)) files.push(full);
    }
  }
  await walk(path.join(PROJECT_ROOT, 'Source'));
  await walk(path.join(PROJECT_ROOT, 'Plugins'));
  return files;
}

async function discoverModuleIncludes() {
  const includes = new Set();
  async function scan(sourceRoot) {
    let entries;
    try {
      entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const sub of ['Public', 'Private']) {
        const p = path.join(sourceRoot, e.name, sub);
        try {
          await fs.promises.access(p);
          includes.add(normalize(p));
        } catch {
          // skip
        }
      }
    }
  }
  await scan(path.join(PROJECT_ROOT, 'Source'));
  const plugins = path.join(PROJECT_ROOT, 'Plugins');
  try {
    const entries = await fs.promises.readdir(plugins, { withFileTypes: true });
    for (const p of entries) {
      if (p.isDirectory()) await scan(path.join(plugins, p.name, 'Source'));
    }
  } catch {
    // no plugins
  }
  return [...includes];
}

async function resolveEngineModulePublic(moduleName) {
  const engineSource = path.join(ENGINE_ROOT, 'Engine', 'Source');
  for (const root of ['Runtime', 'Developer', 'Editor', 'Programs']) {
    const candidate = path.join(engineSource, root, moduleName, 'Public');
    if (fs.existsSync(candidate)) return normalize(candidate);
  }
  return undefined;
}

async function syntheticFlags(moduleIncludes) {
  const flags = [
    '-std=c++20',
    '-fms-compatibility',
    '-fms-extensions',
    '-Wno-unknown-pragmas',
    '-DUE_BUILD_DEVELOPMENT=1',
    '-DWITH_EDITOR=1',
    '-DPLATFORM_WINDOWS=1',
    '-DUE5_8_CURSOR_SYNTHETIC_COMPILE_DB=1',
  ];
  const includes = new Set(moduleIncludes);
  for (const mod of ['Core', 'CoreUObject', 'Engine', 'InputCore']) {
    const inc = await resolveEngineModulePublic(mod);
    if (inc) includes.add(inc);
  }
  for (const inc of includes) {
    flags.push('-I', inc);
  }
  return flags;
}

async function writeClangd(stubsPath, extraFlags) {
  const addLines = extraFlags.map((f) => `    - ${f}`).join('\n');
  const block = [
    CLANGD_BEGIN,
    '# UE 5.8 + clangd + UHT IDE stubs',
    'CompileFlags:',
    '  CompilationDatabase: .',
    '  Add:',
    addLines,
    '  Remove:',
    '    - -W*',
    'Index:',
    '  Background: Build',
    'Diagnostics:',
    '  Suppress:',
    '    - unknown_typename',
    '    - err_unknown_typename',
    '    - pp_file_not_found',
    '    - member_function_call_bad_type',
    '    - ovl_no_viable_member_function_in_call',
    'Completion:',
    '  AllScopes: true',
    CLANGD_END,
  ].join('\n');
  await fs.promises.writeFile(path.join(PROJECT_ROOT, '.clangd'), `${block}\n`, 'utf-8');
}

async function writeSettings() {
  const vscodeDir = path.join(PROJECT_ROOT, '.vscode');
  await fs.promises.mkdir(vscodeDir, { recursive: true });
  const settings = {
    'ue58rider.generated': true,
    'C_Cpp.intelliSenseEngine': 'disabled',
    'C_Cpp.autocomplete': 'disabled',
    'C_Cpp.errorSquiggles': 'disabled',
    'clangd.arguments': ['--background-index', '--completion-style=detailed', '-j=12'],
    'clangd.fallbackFlags': ['-std=c++20'],
    'files.associations': { '*.h': 'cpp', '*.Build.cs': 'csharp' },
    '[cpp]': { 'editor.wordBasedSuggestions': 'off' },
  };
  await fs.promises.writeFile(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

async function writeMcpConfig() {
  const cursorDir = path.join(PROJECT_ROOT, '.cursor');
  await fs.promises.mkdir(cursorDir, { recursive: true });
  const mcp = {
    mcpServers: {
      'unreal-engine-58': {
        type: 'http',
        url: 'http://127.0.0.1:8000/mcp',
      },
      'unreal-mcp': {
        type: 'http',
        url: 'http://127.0.0.1:8000/mcp',
      },
      'ue5-8-cursor': {
        command: 'node',
        args: [path.join(EXT_ROOT, 'dist', 'mcp-server.js')],
        env: {
          UE5_8_CURSOR_WORKSPACE: PROJECT_ROOT,
        },
      },
    },
  };
  await fs.promises.writeFile(path.join(cursorDir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n', 'utf-8');
}

async function main() {
  log(`Project: ${PROJECT_ROOT}`);
  log(`Engine:  ${ENGINE_ROOT}`);

  const cppFiles = await collectCpp();
  const dataDir = path.join(PROJECT_ROOT, '.ue5_8cursor');
  await fs.promises.mkdir(dataDir, { recursive: true });
  const stubsSrc = path.join(EXT_ROOT, 'templates', 'UHTIDEStubs.h');
  const stubsDest = path.join(dataDir, 'UHTIDEStubs.h');
  await fs.promises.copyFile(stubsSrc, stubsDest);
  const stubsPath = normalize(stubsDest);
  const moduleIncludes = await discoverModuleIncludes();

  const rspFiles = await findRsp();
  let flags;
  if (rspFiles.length > 0) {
    log(`Found ${rspFiles.length} Shared.rsp file(s)`);
    const primaryRsp = rspFiles.find((p) => p.includes(path.basename(PROJECT_ROOT))) ?? rspFiles[0];
    flags = parseRsp(primaryRsp);
    const objRsp = await findObjRspNear(primaryRsp);
    if (objRsp) {
      appendPairedFlags(flags, parseObjRspForceIncludes(objRsp));
    }
    log(`Parsed ${flags.length} clang flags from ${path.basename(primaryRsp)}`);
  } else {
    flags = await syntheticFlags(moduleIncludes);
    log(`No Shared.rsp found — wrote synthetic compile_commands (${flags.length} base flags).`);
  }

  const entries = cppFiles.map((file) => {
    const parts = [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === '-I' || f === '-include') {
        parts.push(`${f} "${flags[++i]}"`);
      } else {
        parts.push(f.includes(' ') ? `"${f}"` : f);
      }
    }
    return {
      directory: normalize(PROJECT_ROOT),
      file: normalize(file),
      command: `clang++ ${parts.join(' ')} -c ${normalize(file)}`,
    };
  });
  await fs.promises.writeFile(
    path.join(PROJECT_ROOT, 'compile_commands.json'),
    JSON.stringify(entries, null, 2) + '\n',
    'utf-8',
  );
  log(`Wrote compile_commands.json (${entries.length} entries)`);

  const clangdAdd = ['-include', stubsPath, ...moduleIncludes.flatMap((i) => ['-I', i])];
  await writeClangd(stubsPath, clangdAdd);
  log(`Wrote .clangd (${moduleIncludes.length} module Public/Private paths)`);

  await writeSettings();
  log('Wrote .vscode/settings.json (cpptools off, clangd on)');
  await writeMcpConfig();
  log('Wrote .cursor/mcp.json (UE MCP port 8000)');

  log('Done. Cursor에서 "clangd: Restart language server" 실행하세요.');
  log('완전 IntelliSense가 필요하면 UE5_8 Cursor v6 bootstrap 또는 UBT Editor build가 Intermediate/UHT 캐시를 자동 생성합니다.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
