#!/usr/bin/env node
/**
 * Project_MJS v5.4 verification helper (steps 2–5).
 * Usage: node scripts/project-mjs-verify.mjs [--capture-schema] [--enrich-mcp]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = process.env.PROJECT_MJS_ROOT ?? path.resolve(EXT_ROOT, '..', 'Project_MJS');
const UPROJECT = path.join(PROJECT_ROOT, 'Project_MJS.uproject');
const DATA_DIR = path.join(PROJECT_ROOT, '.ue5_8cursor');
const MCP_PORT = 8000;
const REQUIRED_PLUGINS = ['ModelContextProtocol', 'AllToolsets'];
const ASSET_EXT = ['.uasset', '.umap'];

const args = new Set(process.argv.slice(2));
const captureSchema = args.has('--capture-schema');
const enrichMcp = args.has('--enrich-mcp');

function log(msg) {
  console.log(`[project-mjs-verify] ${msg}`);
}

async function patchUproject() {
  const raw = await fs.promises.readFile(UPROJECT, 'utf-8');
  const data = JSON.parse(raw);
  data.Plugins ??= [];
  let changed = false;
  for (const name of REQUIRED_PLUGINS) {
    const idx = data.Plugins.findIndex((p) => p.Name === name);
    if (idx === -1) {
      data.Plugins.push({ Name: name, Enabled: true });
      changed = true;
      log(`Added plugin: ${name}`);
    } else if (!data.Plugins[idx].Enabled) {
      data.Plugins[idx].Enabled = true;
      changed = true;
      log(`Enabled plugin: ${name}`);
    }
  }
  if (changed) {
    await fs.promises.writeFile(UPROJECT, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } else {
    log('MCP plugins already present in .uproject');
  }
  return changed;
}

async function ensureMcpJson() {
  const cursorDir = path.join(PROJECT_ROOT, '.cursor');
  await fs.promises.mkdir(cursorDir, { recursive: true });
  const configPath = path.join(cursorDir, 'mcp.json');
  const extScript = path.join(EXT_ROOT, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const servers = {
    'unreal-engine-58': { type: 'http', url: `http://127.0.0.1:${MCP_PORT}/mcp` },
    'unreal-mcp': { type: 'http', url: `http://127.0.0.1:${MCP_PORT}/mcp` },
    'ue5-8-cursor': {
      command: 'node',
      args: [extScript],
      env: { UE5_8_CURSOR_WORKSPACE: PROJECT_ROOT.replace(/\\/g, '/') },
    },
  };
  const content = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  let existing = '';
  try {
    existing = await fs.promises.readFile(configPath, 'utf-8');
  } catch {
    // new
  }
  if (existing !== content) {
    await fs.promises.writeFile(configPath, content, 'utf-8');
    log(`Wrote ${configPath}`);
  } else {
    log('mcp.json already up to date');
  }
}

function contentToAssetPath(relFromContent, assetName) {
  const withoutExt = relFromContent.replace(/\\/g, '/').replace(/\.(uasset|umap)$/i, '');
  const gamePath = withoutExt.startsWith('Content/') ? withoutExt.slice('Content/'.length) : withoutExt;
  return `/Game/${gamePath}.${assetName}`;
}

function inferClass(name) {
  if (/^BP_/i.test(name)) return 'Blueprint';
  if (/^M_/i.test(name)) return 'Material';
  if (/^SM_/i.test(name)) return 'StaticMesh';
  if (/^L_/i.test(name)) return 'World';
  return undefined;
}

async function scanAssets(dir, depth, results) {
  if (depth <= 0) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && ASSET_EXT.some((x) => e.name.toLowerCase().endsWith(x))) {
      results.push(full);
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      await scanAssets(full, depth - 1, results);
    }
  }
}

async function buildAssetIndex() {
  const contentDir = path.join(PROJECT_ROOT, 'Content');
  const files = [];
  await scanAssets(contentDir, 16, files);
  const entries = [];
  for (const filePath of files) {
    const base = path.basename(filePath);
    const ext = ASSET_EXT.find((x) => base.toLowerCase().endsWith(x));
    const assetName = ext ? base.slice(0, -ext.length) : path.basename(filePath, path.extname(filePath));
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
    } catch {
      // ignore
    }
    const rel = path.relative(contentDir, filePath);
    entries.push({
      diskPath: filePath,
      assetPath: contentToAssetPath(path.join('Content', rel), assetName),
      fileName: base,
      assetName,
      inferredClass: inferClass(assetName),
      mtimeMs,
    });
  }
  entries.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const cache = {
    version: 2,
    updatedAt: new Date().toISOString(),
    entries,
  };
  const out = path.join(DATA_DIR, 'asset-index.json');
  await fs.promises.writeFile(out, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  log(`Asset index: ${entries.length} entries → ${out}`);
  return entries.length;
}

function mcpJsonRpc(port, method, params, timeoutMs = 8000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.write(body);
    req.end();
  });
}

async function probeMcp(port) {
  const json = await mcpJsonRpc(port, 'tools/list', {}, 2000);
  return json !== undefined && !json.error;
}

async function listToolsets(port) {
  const json = await mcpJsonRpc(port, 'tools/call', {
    name: 'list_toolsets',
    arguments: {},
  });
  const text = json?.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.toolsets)) return parsed.toolsets;
  } catch {
    // try line parse
  }
  return text.split('\n').filter((l) => l.trim().length > 0);
}

async function describeToolset(port, toolset) {
  const json = await mcpJsonRpc(port, 'tools/call', {
    name: 'describe_toolset',
    arguments: { toolset },
  });
  return json?.result?.content?.find((c) => c.type === 'text')?.text;
}

async function captureMcpSchema(port) {
  const fallback = JSON.parse(
    await fs.promises.readFile(path.join(EXT_ROOT, 'schemas', 'ue58-mcp-fallback.json'), 'utf-8'),
  );
  const toolsets = await listToolsets(port);
  log(`MCP toolsets (${toolsets.length}): ${toolsets.slice(0, 8).join(', ')}${toolsets.length > 8 ? '...' : ''}`);

  const toolsetDetails = {};
  const priority = ['AssetTools', 'BlueprintTools', 'LiveCodingToolset', 'EditorTools', 'EditorAssetTools'];
  const toDescribe = [
    ...priority.filter((t) => toolsets.includes(t)),
    ...toolsets.filter((t) => !priority.includes(t)),
  ].slice(0, 20);

  for (const ts of toDescribe) {
    const desc = await describeToolset(port, ts);
    if (desc) {
      try {
        toolsetDetails[ts] = JSON.parse(desc);
      } catch {
        toolsetDetails[ts] = { raw: desc };
      }
    }
  }

  const captured = {
    ...fallback,
    capturedAt: new Date().toISOString(),
    toolsets: toolsetDetails,
  };

  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const projectSchema = path.join(DATA_DIR, 'mcp-schema.json');
  await fs.promises.writeFile(projectSchema, JSON.stringify(captured, null, 2) + '\n', 'utf-8');
  log(`Wrote ${projectSchema}`);

  const ciFixture = path.join(EXT_ROOT, 'schemas', 'ue58-mcp-captured.json');
  await fs.promises.writeFile(ciFixture, JSON.stringify(captured, null, 2) + '\n', 'utf-8');
  log(`Updated CI fixture ${ciFixture}`);

  return captured;
}

async function runChecklist(assetCount, mcpUp) {
  const report = {
    projectRoot: PROJECT_ROOT,
    mcpPluginsInUproject: REQUIRED_PLUGINS.every((n) => {
      const data = JSON.parse(fs.readFileSync(UPROJECT, 'utf-8'));
      return data.Plugins?.some((p) => p.Name === n && p.Enabled);
    }),
    mcpJsonExists: fs.existsSync(path.join(PROJECT_ROOT, '.cursor', 'mcp.json')),
    dataDirExists: fs.existsSync(DATA_DIR),
    assetIndexCount: assetCount,
    mcpConnected: mcpUp,
    sourceGamePaths: 0,
  };

  const sourceDir = path.join(PROJECT_ROOT, 'Source');
  async function grepGame(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.(cpp|h)$/.test(e.name)) {
        const text = await fs.promises.readFile(full, 'utf-8');
        const matches = text.match(/\/Game\/[A-Za-z0-9_./-]+/g);
        if (matches) report.sourceGamePaths += matches.length;
      } else if (e.isDirectory()) {
        await grepGame(full);
      }
    }
  }
  await grepGame(sourceDir);

  const reportPath = path.join(DATA_DIR, 'verification-report.json');
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  log(`Verification report → ${reportPath}`);
  log(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  log(`Project: ${PROJECT_ROOT}`);
  if (!fs.existsSync(UPROJECT)) {
    console.error('Project_MJS.uproject not found');
    process.exit(1);
  }

  await patchUproject();
  await ensureMcpJson();
  const assetCount = await buildAssetIndex();

  const mcpUp = await probeMcp(MCP_PORT);
  if (mcpUp) {
    log(`MCP online at port ${MCP_PORT}`);
    if (captureSchema || enrichMcp) {
      await captureMcpSchema(MCP_PORT);
    }
  } else {
    log(`MCP offline at port ${MCP_PORT} — start UE Editor with AllToolsets, then re-run with --capture-schema`);
  }

  const report = await runChecklist(assetCount, mcpUp);
  const ok =
    report.mcpPluginsInUproject &&
    report.mcpJsonExists &&
    report.dataDirExists;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
