const SCHEMA_VERSION = '1.0';

const EVENT_TYPES = new Set([
  'session_start',
  'session_end',
  'request_start',
  'user_message',
  'reasoning',
  'assistant_message',
  'tool_call',
  'tool_result',
  'usage',
  'error',
  'request_end',
]);

function createEvent(input = {}) {
  if (!EVENT_TYPES.has(input.event_type)) {
    throw new Error(`Unsupported trace event type: ${input.event_type || '<empty>'}`);
  }
  return {
    schema_version: SCHEMA_VERSION,
    session_id: String(input.session_id || ''),
    request_id: String(input.request_id || ''),
    agent: String(input.agent || 'unknown'),
    provider: String(input.provider || 'unknown'),
    model: String(input.model || ''),
    event_type: input.event_type,
    timestamp: normalizeTimestamp(input.timestamp),
    content: clone(input.content ?? null),
    source: String(input.source || 'unknown'),
  };
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid trace timestamp: ${value}`);
  return parsed.toISOString();
}

function clone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

module.exports = { EVENT_TYPES, SCHEMA_VERSION, createEvent };
