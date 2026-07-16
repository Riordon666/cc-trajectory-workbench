const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_TYPES, createEvent } = require('../workbench/core/event-schema');

test('generic event schema keeps a stable field set', () => {
  const event = createEvent({
    session_id: 'synthetic-session',
    request_id: 'req-1',
    agent: 'claude-code',
    provider: 'anthropic',
    model: 'claude-synthetic-test-model',
    event_type: 'assistant_message',
    timestamp: '2026-01-01T00:00:00Z',
    content: { text: 'synthetic response' },
    source: 'fixture',
  });
  assert.deepEqual(Object.keys(event), [
    'schema_version', 'session_id', 'request_id', 'agent', 'provider',
    'model', 'event_type', 'timestamp', 'content', 'source',
  ]);
  assert.equal(event.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(EVENT_TYPES.size, 11);
});

test('generic event schema rejects invented event types', () => {
  assert.throws(() => createEvent({ event_type: 'fake_cot' }), /Unsupported trace event type/);
});
