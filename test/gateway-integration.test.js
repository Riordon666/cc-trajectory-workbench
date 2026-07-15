const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('../workbench/server/gateway');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('gateway forwards SSE immediately and captures normalized events', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'synthetic-response', model: 'gpt-synthetic-full-model' } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', model: 'gpt-synthetic-full-model', usage: { output_tokens: 1 } } })}\n\n`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const previous = process.env.OPENAI_UPSTREAM_BASE_URL;
  process.env.OPENAI_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_UPSTREAM_BASE_URL; else process.env.OPENAI_UPSTREAM_BASE_URL = previous; });
  const captures = [];
  const handler = createGateway({ resolveSession: () => ({ id: 'synthetic', agent: 'codex-cli' }), onCapture: (capture) => captures.push(capture) });
  const gateway = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await handler(req, res, url)) { res.writeHead(404); res.end(); }
  });
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const body = JSON.stringify({ model: 'gpt-synthetic-full-model', input: 'synthetic user', stream: true });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/openai/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /hello/);
  const final = captures.find((capture) => capture.phase === 'response');
  assert.ok(final.events.some((event) => event.event_type === 'assistant_message'));
  assert.ok(final.events.some((event) => event.event_type === 'request_end'));
});
