const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedHostname, requestToEvents, resolveUpstream } = require('../workbench/server/gateway');

test('gateway has fixed routes and rejects unsafe upstream origins', () => {
  assert.equal(isBlockedHostname('169.254.169.254'), true);
  assert.equal(isBlockedHostname('192.168.1.2'), true);
  const previous = process.env.OPENAI_UPSTREAM_BASE_URL;
  process.env.OPENAI_UPSTREAM_BASE_URL = 'https://user:password@example.com/private';
  assert.throws(() => resolveUpstream({ env: 'OPENAI_UPSTREAM_BASE_URL', fallback: 'https://api.openai.com' }), /without credentials/);
  if (previous === undefined) delete process.env.OPENAI_UPSTREAM_BASE_URL; else process.env.OPENAI_UPSTREAM_BASE_URL = previous;
});

test('gateway converts request input without inventing reasoning', () => {
  const events = requestToEvents('openai-responses', { model: 'gpt-synthetic-full-model', input: 'hello', stream: true }, { session_id: 'synthetic', request_id: 'r1', agent: 'codex-cli', provider: 'openai', model: 'gpt-synthetic-full-model', source: 'fixture' });
  assert.ok(events.some((event) => event.event_type === 'request_start'));
  assert.ok(events.some((event) => event.event_type === 'user_message'));
  assert.equal(events.some((event) => event.event_type === 'reasoning'), false);
});
