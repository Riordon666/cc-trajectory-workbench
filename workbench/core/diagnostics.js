const { EVENT_TYPES, SCHEMA_VERSION } = require('./event-schema');
const { eventFingerprint } = require('./event-store');

function diagnoseEvents(events, parseErrors = []) {
  const items = parseErrors.map((error) => item('error', 'invalid_jsonl', `Line ${error.line}: ${error.message}`));
  const requests = new Map();
  const toolCalls = new Map();
  const toolResults = new Set();
  const fingerprints = new Set();
  const sessionIds = new Set();
  const models = new Set();
  let previousTime = -Infinity;
  let reasoningCount = 0;

  for (const event of events) {
    if (event.schema_version !== SCHEMA_VERSION) items.push(item('warning', 'unsupported_schema_version', `Observed schema ${event.schema_version || '<missing>'}`));
    if (!EVENT_TYPES.has(event.event_type)) items.push(item('info', 'unknown_event_type', `Unknown event type is preserved: ${event.event_type || '<missing>'}`));
    const time = new Date(event.timestamp).getTime();
    if (!Number.isFinite(time)) items.push(item('error', 'invalid_timestamp', `Invalid timestamp on ${event.event_type || 'event'}`));
    else if (time < previousTime) items.push(item('warning', 'timestamp_out_of_order', 'Events are not in timestamp order'));
    else previousTime = time;
    if (event.session_id) sessionIds.add(event.session_id);
    if (event.model) models.add(event.model);
    const fingerprint = eventFingerprint(event);
    if (fingerprints.has(fingerprint)) items.push(item('warning', 'duplicate_event', `Duplicate ${event.event_type}`));
    fingerprints.add(fingerprint);
    if (event.request_id) {
      const request = requests.get(event.request_id) || { start: 0, end: 0, errors: 0 };
      if (event.event_type === 'request_start') request.start++;
      if (event.event_type === 'request_end') request.end++;
      if (event.event_type === 'error') request.errors++;
      requests.set(event.request_id, request);
    }
    if (event.event_type === 'reasoning') reasoningCount++;
    if (event.event_type === 'tool_call') toolCalls.set(toolId(event), event);
    if (event.event_type === 'tool_result') toolResults.add(toolId(event));
    if (event.event_type === 'error' && event.content?.cancelled) items.push(item('warning', 'client_cancelled', 'Client cancelled a request'));
    if (event.event_type === 'error') items.push(item('error', 'protocol_error', event.content?.message || 'Protocol or upstream error'));
  }
  if (sessionIds.size > 1) items.push(item('error', 'session_id_mismatch', `Observed ${sessionIds.size} session IDs`));
  if (models.size > 1) items.push(item('warning', 'model_mismatch', `Observed models: ${[...models].join(', ')}`));
  for (const [requestId, request] of requests) {
    if (request.start && !request.end) items.push(item('warning', 'incomplete_request', `Request ${requestId} has no request_end`));
    if (!request.start && request.end) items.push(item('warning', 'missing_request_start', `Request ${requestId} has no request_start`));
  }
  for (const id of toolCalls.keys()) if (id && !toolResults.has(id)) items.push(item('warning', 'missing_tool_result', `No result for tool call ${id}`));
  for (const id of toolResults) if (id && !toolCalls.has(id)) items.push(item('warning', 'unmatched_tool_result', `No call for tool result ${id}`));
  diagnoseSourceAlignment(events, items);
  if (!reasoningCount) items.push(item('info', 'reasoning_unavailable', 'Reasoning was not provided by the Agent or API'));
  return summarize(items, { events: events.length, requests: requests.size, models: [...models], reasoningEvents: reasoningCount });
}

function diagnoseSourceAlignment(events, items) {
  const protocol = events.filter((event) => event.source === 'gateway' || event.source === 'proxy');
  const history = events.filter((event) => event.source === 'agent-history');
  if (!protocol.length || !history.length) return;
  for (const type of ['user_message', 'assistant_message', 'reasoning', 'tool_call', 'tool_result']) {
    const left = protocol.filter((event) => event.event_type === type).map(comparableContent);
    const right = history.filter((event) => event.event_type === type).map(comparableContent);
    if (left.length !== right.length) items.push(item(type === 'reasoning' ? 'warning' : 'error', 'dual_source_count_mismatch', `${type}: protocol=${left.length}, history=${right.length}`));
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count; index++) {
      if (left[index] !== right[index]) items.push(item(type === 'reasoning' ? 'warning' : 'error', type === 'reasoning' ? 'reasoning_source_mismatch' : 'dual_source_content_mismatch', `${type} differs at position ${index + 1}`));
    }
  }
}

function comparableContent(event) {
  const content = event.content || {};
  if (event.event_type === 'user_message' || event.event_type === 'assistant_message' || event.event_type === 'reasoning') return String(content.text || content.delta || '').replace(/\s+/g, ' ').trim();
  return JSON.stringify(content);
}

function toolId(event) {
  return String(event.content?.call_id || event.content?.tool_use_id || event.content?.id || '');
}

function item(level, code, message) { return { level, code, message }; }

function summarize(items, stats = {}) {
  return {
    generated_at: new Date().toISOString(),
    non_blocking: true,
    status: items.some((entry) => entry.level === 'error') ? 'error' : items.some((entry) => entry.level === 'warning') ? 'warning' : 'ok',
    counts: {
      info: items.filter((entry) => entry.level === 'info').length,
      warning: items.filter((entry) => entry.level === 'warning').length,
      error: items.filter((entry) => entry.level === 'error').length,
    },
    stats,
    items,
  };
}

module.exports = { diagnoseEvents, item, summarize };
