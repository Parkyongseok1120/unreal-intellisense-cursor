import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

function extractText(json) {
  return json.result?.content?.find((c) => c.type === 'text')?.text;
}

async function mcpJsonRpc(port, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('epicMcpClient mock HTTP', () => {
  /** @type {import('node:http').Server} */
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'list_toolsets' }, { name: 'call_tool' }] },
            }),
          );
          return;
        }
        if (msg.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: '{"ok":true}' }] },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('tools/list returns meta tools', async () => {
    const json = await mcpJsonRpc(port, 'tools/list', {});
    assert.ok(json.result.tools.some((t) => t.name === 'call_tool'));
  });

  it('tools/call returns text content', async () => {
    const json = await mcpJsonRpc(port, 'tools/call', {
      name: 'call_tool',
      arguments: { toolset: 'AssetTools', tool: 'open_asset' },
    });
    const text = extractText(json);
    assert.equal(text, '{"ok":true}');
  });
});
