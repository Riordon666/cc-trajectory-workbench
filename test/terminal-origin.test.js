const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { attachTerminal } = require('../workbench/server/terminal');

test('terminal websocket rejects a foreign Origin before spawning a PTY', async (t) => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const terminal = attachTerminal(server, { host: '127.0.0.1', port, rootDir: __dirname });
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, { origin: 'https://evil.example' });
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.on('open', () => reject(new Error('foreign origin unexpectedly opened')));
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
  assert.equal(terminal.activeCount(), 0);
});
