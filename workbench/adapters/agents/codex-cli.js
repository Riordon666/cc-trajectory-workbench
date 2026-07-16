const fs = require('fs');
const path = require('path');
const { createEvent } = require('../../core/event-schema');

const id = 'codex-cli';

function codexRoot() {
  return path.join(process.env.CODEX_HOME || process.env.USERPROFILE || process.env.HOME || '', process.env.CODEX_HOME ? '' : '.codex');
}

function detectFormat(entries) {
  if (entries.some((entry) => entry?.type === 'session_meta' && entry?.payload)) return 'rollout-v1';
  if (entries.some((entry) => entry?.type === 'response_item' || entry?.type === 'event_msg')) return 'rollout-v1';
  if (entries.some((entry) => entry?.role || entry?.type === 'message')) return 'rollout-v0';
  return 'unknown';
}

function parseHistory(filePath) {
  const entries = [];
  const errors = [];
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { entries.push(JSON.parse(line)); } catch (error) { errors.push({ line: index + 1, message: error.message }); }
  });
  const formatVersion = detectFormat(entries);
  const metadata = readMetadata(entries, filePath, formatVersion);
  return { entries, errors, formatVersion, metadata, filePath };
}

function readMetadata(entries, filePath, formatVersion) {
  const meta = entries.find((entry) => entry?.type === 'session_meta')?.payload || {};
  const context = entries.find((entry) => entry?.type === 'turn_context')?.payload || {};
  const filenameId = path.basename(filePath, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] || path.basename(filePath, '.jsonl');
  return {
    sessionId: String(meta.session_id || meta.id || filenameId),
    model: String(context.model || ''),
    provider: String(meta.model_provider || 'openai'),
    cliVersion: String(meta.cli_version || ''),
    cwd: String(meta.cwd || context.cwd || ''),
    formatVersion,
  };
}

function historyToEvents(parsed, context = {}) {
  const data = Array.isArray(parsed) ? { entries: parsed, errors: [], formatVersion: detectFormat(parsed), metadata: {} } : parsed;
  if (data.formatVersion === 'rollout-v0') return legacyEvents(data.entries, context);
  const events = [];
  const meta = data.metadata || {};
  let requestId = '';
  let model = meta.model || context.model || '';
  const base = (entry, overrides = {}) => ({
    session_id: context.session_id || meta.sessionId || '',
    request_id: overrides.request_id ?? requestId,
    agent: id,
    provider: meta.provider || context.provider || 'openai',
    model: overrides.model ?? model,
    timestamp: entry.timestamp,
    source: context.source || 'agent-history',
  });

  for (const entry of data.entries || []) {
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') {
      events.push(createEvent({ ...base(entry), event_type: 'session_start', content: safeMetadata(meta) }));
      continue;
    }
    if (entry.type === 'turn_context') {
      requestId = String(payload.turn_id || requestId || '');
      model = String(payload.model || model || '');
      continue;
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_started') {
        requestId = String(payload.turn_id || requestId || '');
        events.push(createEvent({ ...base(entry), event_type: 'request_start', content: { collaboration_mode: payload.collaboration_mode_kind || null } }));
      } else if (payload.type === 'user_message') {
        events.push(createEvent({ ...base(entry), event_type: 'user_message', content: { text: String(payload.message || '') } }));
      } else if (payload.type === 'agent_reasoning' && payload.text) {
        events.push(createEvent({ ...base(entry), event_type: 'reasoning', content: { text: String(payload.text), kind: 'summary' } }));
      } else if (payload.type === 'token_count' && payload.info) {
        events.push(createEvent({ ...base(entry), event_type: 'usage', content: payload.info }));
      } else if (payload.type === 'turn_aborted') {
        events.push(createEvent({ ...base(entry), event_type: 'error', content: { message: String(payload.reason || 'Turn aborted'), cancelled: true } }));
        events.push(createEvent({ ...base(entry), event_type: 'request_end', content: { complete: false, cancelled: true } }));
      } else if (payload.type === 'task_complete') {
        events.push(createEvent({ ...base(entry), event_type: 'request_end', content: { complete: true, duration_ms: payload.duration_ms ?? null } }));
      }
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (payload.type === 'message') {
      const text = contentText(payload.content);
      if (payload.role === 'user' && text) events.push(createEvent({ ...base(entry), event_type: 'user_message', content: { text } }));
      if (payload.role === 'assistant' && text) events.push(createEvent({ ...base(entry), event_type: 'assistant_message', content: { text, phase: payload.phase || null } }));
    } else if (payload.type === 'agent_message') {
      const text = contentText(payload.content);
      if (text) events.push(createEvent({ ...base(entry), event_type: 'assistant_message', content: { text } }));
    } else if (payload.type === 'reasoning') {
      const summary = contentText(payload.summary);
      if (summary) events.push(createEvent({ ...base(entry), event_type: 'reasoning', content: { text: summary, kind: 'summary' } }));
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      events.push(createEvent({ ...base(entry), event_type: 'tool_call', content: {
        id: payload.id || '', call_id: payload.call_id || '', name: payload.name || '',
        namespace: payload.namespace || '', input: parseMaybeJson(payload.arguments ?? payload.input),
      } }));
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      events.push(createEvent({ ...base(entry), event_type: 'tool_result', content: {
        id: payload.id || '', call_id: payload.call_id || '', output: payload.output ?? null,
      } }));
    }
  }
  if (events.length) {
    const last = events.at(-1);
    if (last.event_type !== 'session_end') events.push(createEvent({ ...last, event_type: 'session_end', content: { inferred_from_file_end: true } }));
  }
  return dedupeSemantic(events);
}

function legacyEvents(entries, context) {
  const events = [];
  for (const entry of entries) {
    const role = entry.role || entry.message?.role;
    const text = contentText(entry.content ?? entry.message?.content);
    const eventType = role === 'user' ? 'user_message' : role === 'assistant' ? 'assistant_message' : null;
    if (eventType && text) events.push(createEvent({
      session_id: context.session_id || entry.session_id || '', request_id: entry.turn_id || entry.id || '',
      agent: id, provider: entry.provider || 'openai', model: entry.model || '', event_type: eventType,
      timestamp: entry.timestamp, content: { text }, source: context.source || 'agent-history',
    }));
  }
  return events;
}

function dedupeSemantic(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = JSON.stringify([event.request_id, event.event_type, event.content]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content.text || '');
  return content.map((block) => typeof block === 'string' ? block : block?.text || '').filter(Boolean).join('\n');
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function safeMetadata(meta) {
  return { format_version: meta.formatVersion, cli_version: meta.cliVersion, cwd: meta.cwd };
}

function classifyRequest(record = {}) {
  const type = record.payload?.type || record.type || '';
  if (type === 'task_started' || type === 'user_message') return 'main';
  if (/compact|summary/i.test(type)) return 'side-summary';
  return 'side-other';
}

function discoverLocalSessions() {
  const root = path.join(codexRoot(), 'sessions');
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        const stat = fs.statSync(file);
        let metadata = {};
        try { metadata = parseHistoryHead(file); } catch {}
        files.push({ path: file, sessionId: metadata.sessionId || path.basename(file, '.jsonl'), project: metadata.cwd || '', formatVersion: metadata.formatVersion || 'unknown', model: metadata.model || '', provider: metadata.provider || 'openai', size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }
  }
  return files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, 50);
}

function parseHistoryHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    const entries = buffer.toString('utf8').split(/\r?\n/).slice(0, -1).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const formatVersion = detectFormat(entries);
    return readMetadata(entries, file, formatVersion);
  } finally { fs.closeSync(fd); }
}

const adapter = { id, displayName: 'Codex CLI', protocols: ['openai-responses'], classifyRequest, detectFormat, discoverLocalSessions, historyToEvents, parseHistory };
module.exports = { ...adapter, adapter };
