import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const rpc = loadTsModule('src/editorBridge/editorBridgeRpc.ts', {
  '../platform/dataDir': () => ({
    ensureDataDir: async (root) => path.join(root, '.ue5_8cursor'),
  }),
  '../platform/workspaceMutation': () => ({
    runWithTransaction: async (_root, fn) => fn({}),
    mutateText: async () => {},
  }),
  '../parsers/uprojectParser': () => ({
    ensurePluginInUProject: async () => false,
  }),
  '../version': () => ({
    getExtensionVersion: () => '6.6.1',
  }),
});

let server;
let port;
let token;
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ue58-bridge-'));

before(async () => {
  token = 'test-token';
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reqJson = JSON.parse(body);
      let result = {};
      if (reqJson.method === 'handshake') {
        result = { ok: true, capabilities: ['assetRegistry', 'automationTests'] };
      } else if (reqJson.method === 'automation.list') {
        result = { tests: [{ name: 'Project.Smoke', source: 'automation' }] };
      } else if (reqJson.method === 'assetRegistry.list') {
        result = { assets: [{ assetPath: '/Game/Maps/Start', className: 'World' }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: reqJson.id, result }));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  const dataDir = path.join(projectRoot, '.ue5_8cursor');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'editor-bridge.json'),
    JSON.stringify({
      port,
      pid: process.pid,
      token,
      protocolVersion: 1,
      capabilities: ['assetRegistry', 'automationTests'],
      transport: 'http',
    }),
  );
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('editor bridge rpc', () => {
  it('reads descriptor and completes handshake', async () => {
    const descriptor = await rpc.readEditorBridgeDescriptor(projectRoot);
    assert.ok(descriptor);
    const result = await rpc.editorBridgeRpc(descriptor, 'handshake', { client: 'ue58rider', version: 1 });
    assert.equal(result.ok, true);
  });

  it('lists automation tests via rpc', async () => {
    const descriptor = await rpc.readEditorBridgeDescriptor(projectRoot);
    const result = await rpc.editorBridgeRpc(descriptor, 'automation.list', {});
    assert.equal(result.tests.length, 1);
  });

  it('lists assets via assetRegistry.list', async () => {
    const descriptor = await rpc.readEditorBridgeDescriptor(projectRoot);
    const result = await rpc.editorBridgeRpc(descriptor, 'assetRegistry.list', {});
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].assetPath, '/Game/Maps/Start');
  });

  it('rejects slow RPC via timeout', async () => {
    const descriptor = await rpc.readEditorBridgeDescriptor(projectRoot);
    const slowServer = http.createServer(() => {
      // never respond
    });
    await new Promise((resolve) => slowServer.listen(descriptor.port + 50, '127.0.0.1', resolve));
    try {
      await rpc.editorBridgeRpc(
        { ...descriptor, port: descriptor.port + 50 },
        'handshake',
        {},
        { timeoutMs: 200 },
      );
      assert.fail('expected timeout');
    } catch (err) {
      assert.match(String(err), /timed out|aborted|ECONNREFUSED/i);
    } finally {
      await new Promise((resolve) => slowServer.close(resolve));
    }
  });
});
