const { createEvent } = require('../../core/event-schema');

const id = 'anthropic-messages';
const displayName = 'Anthropic Messages API';

function detect(firstEvent = {}) {
  return typeof firstEvent.type === 'string'
    && /^(message_|content_block_)/.test(firstEvent.type);
}

function parseSSE(raw, context = {}) {
  const objects = parseDataObjects(raw);
  const events = [];
  const toolCalls = new Map();
  let messageId = context.request_id || '';
  let model = context.model || '';
  let usage = null;
  let content = '';
  let reasoning = '';

  for (const object of objects) {
    if (object.type === 'message_start' && object.message) {
      messageId = object.message.id || messageId;
      model = object.message.model || model;
      usage = mergeUsage(usage, object.message.usage);
      events.push(event(context, messageId, model, 'request_start', { protocol: id }));
      continue;
    }
    if (object.type === 'content_block_start' && object.content_block) {
      const block = object.content_block;
      if (block.type === 'tool_use') {
        toolCalls.set(object.index ?? toolCalls.size, {
          id: block.id || '',
          name: block.name || '',
          arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
        });
      }
      continue;
    }
    if (object.type === 'content_block_delta' && object.delta) {
      const delta = object.delta;
      if (delta.type === 'text_delta' && delta.text) {
        content += delta.text;
        events.push(event(context, messageId, model, 'assistant_message', { delta: delta.text }));
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        reasoning += delta.thinking;
        events.push(event(context, messageId, model, 'reasoning', { delta: delta.thinking }));
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const index = object.index ?? 0;
        const call = toolCalls.get(index) || { id: '', name: '', arguments: '' };
        call.arguments += delta.partial_json;
        toolCalls.set(index, call);
      }
      continue;
    }
    if (object.type === 'content_block_stop') {
      const call = toolCalls.get(object.index);
      if (call) events.push(event(context, messageId, model, 'tool_call', normalizeToolCall(call)));
      continue;
    }
    if (object.type === 'message_delta') {
      usage = mergeUsage(usage, object.usage);
      if (object.usage) events.push(event(context, messageId, model, 'usage', object.usage));
      continue;
    }
    if (object.type === 'error') {
      events.push(event(context, messageId, model, 'error', object.error || object));
      continue;
    }
    if (object.type === 'message_stop') {
      events.push(event(context, messageId, model, 'request_end', { complete: true }));
    }
  }

  return {
    id: messageId,
    model,
    usage,
    content,
    reasoning,
    toolCalls: [...toolCalls.values()].map(normalizeToolCall),
    chunkCount: objects.length,
    apiFormat: id,
    events,
  };
}

function parseJSON(input, context = {}) {
  const object = typeof input === 'string' ? JSON.parse(input) : input || {};
  const messageId = object.id || context.request_id || '';
  const model = object.model || context.model || '';
  const events = [event(context, messageId, model, 'request_start', { protocol: id, streaming: false })];
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of Array.isArray(object.content) ? object.content : []) {
    if (block.type === 'text' && block.text) {
      content += block.text;
      events.push(event(context, messageId, model, 'assistant_message', { text: block.text }));
    } else if ((block.type === 'thinking' || block.type === 'reasoning') && (block.thinking || block.text)) {
      const text = block.thinking || block.text;
      reasoning += text;
      events.push(event(context, messageId, model, 'reasoning', { text }));
    } else if (block.type === 'tool_use') {
      const call = { id: block.id || '', name: block.name || '', input: block.input || {}, arguments: JSON.stringify(block.input || {}) };
      toolCalls.push(call);
      events.push(event(context, messageId, model, 'tool_call', call));
    }
  }
  if (object.usage) events.push(event(context, messageId, model, 'usage', object.usage));
  if (object.error) events.push(event(context, messageId, model, 'error', object.error));
  events.push(event(context, messageId, model, 'request_end', { complete: !object.error }));
  return { id: messageId, model, usage: object.usage || null, content, reasoning, toolCalls, chunkCount: 1, apiFormat: id, events };
}

function parseDataObjects(raw) {
  const objects = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { objects.push(JSON.parse(payload)); } catch {}
  }
  return objects;
}

function normalizeToolCall(call) {
  let input = {};
  try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = call.arguments; }
  return { id: call.id || '', name: call.name || '', arguments: call.arguments || '', input };
}

function mergeUsage(current, incoming) {
  return incoming ? { ...(current || {}), ...incoming } : current;
}

function event(context, requestId, model, type, content) {
  return createEvent({
    ...context,
    request_id: requestId || context.request_id,
    model,
    provider: context.provider || 'anthropic',
    event_type: type,
    content,
    source: context.source || 'proxy',
  });
}

module.exports = { detect, displayName, id, parseDataObjects, parseJSON, parseSSE };
