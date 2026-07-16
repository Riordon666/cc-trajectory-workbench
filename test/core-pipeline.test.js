const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendEvents, readEvents } = require('../workbench/core/event-store');
const { diagnoseEvents } = require('../workbench/core/diagnostics');
const { buildBundle, importBundle } = require('../workbench/core/bundle');
const { findSecrets, redactCredentials, redactHeaders } = require('../workbench/core/redaction');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function syntheticEvent(overrides = {}) {
  return { session_id: 'synthetic', request_id: 'req-1', agent: 'codex-cli', provider: 'openai', model: 'gpt-synthetic-full-model', event_type: 'request_start', timestamp: '2026-01-01T00:00:00Z', content: { protocol: 'openai-responses' }, source: 'fixture', ...overrides };
}

test('event store appends durably, deduplicates and recovers past a malformed tail', (t) => {
  const dir = tempDir(t);
  assert.equal(appendEvents(dir, [syntheticEvent(), syntheticEvent()]).appended, 1);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{broken\n');
  const parsed = readEvents(dir);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.errors.length, 1);
});

test('diagnostics are non-blocking and report incomplete requests and unavailable reasoning', () => {
  const result = diagnoseEvents([syntheticEvent()]);
  assert.equal(result.non_blocking, true);
  assert.ok(result.items.some((item) => item.code === 'incomplete_request'));
  assert.ok(result.items.some((item) => item.code === 'reasoning_unavailable'));
});

test('bundle round trip verifies hashes and redacts secrets', (t) => {
  const source = tempDir(t);
  const target = tempDir(t);
  appendEvents(source, [syntheticEvent({ event_type: 'user_message', content: { text: 'token sk-syntheticSecret123456789' } })]);
  const diagnostics = diagnoseEvents(readEvents(source).events);
  const bundle = buildBundle(source, { id: 'synthetic', agent: 'codex-cli' }, diagnostics);
  assert.equal(findSecrets(bundle.buffer.toString('latin1')).length, 0);
  const imported = importBundle(bundle.buffer, target);
  assert.equal(imported.events, 1);
  assert.match(readEvents(target).events[0].content.text, /\[REDACTED\]/);
});

test('redaction covers headers, nested credential fields and token-like text', () => {
  assert.equal(redactHeaders({ Authorization: 'Bearer secret' }).Authorization, '[REDACTED]');
  assert.deepEqual(redactCredentials({ nested: { api_key: 'secret' } }), { nested: { api_key: '[REDACTED]' } });
  assert.equal(findSecrets('sk-syntheticSecret123456789').length, 1);
});

test('event readers preserve unknown future event types', (t) => {
  const dir = tempDir(t);
  const future = { ...syntheticEvent(), event_type: 'future_protocol_marker', schema_version: '2.0' };
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(future)}\n`);
  const parsed = readEvents(dir);
  assert.equal(parsed.events[0].event_type, 'future_protocol_marker');
  assert.ok(diagnoseEvents(parsed.events).items.some((item) => item.code === 'unknown_event_type'));
});
