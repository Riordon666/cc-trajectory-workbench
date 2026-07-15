const { createEvent } = require('../../core/event-schema');
const { parseDataObjects } = require('./anthropic-messages');

const id = 'openai-responses';
const displayName = 'OpenAI Responses API';

function detect(firstEvent = {}) {
  return typeof firstEvent.type === 'string' && firstEvent.type.startsWith('response.');
}

function parseSSE(raw, context = {}) {
  const objects = parseDataObjects(raw);
  const events = [];
  const toolCalls = new Map();
  let responseId = context.request_id || '';
  let model = context.model || '';
  let usage = null;
  let content = '';
  let reasoning = '';

  for (const object of objects) {
    if (object.type === 'response.created' || object.type === 'response.in_progress') {
      responseId = object.response?.id || responseId;
      model = object.response?.model || model;
      if (object.type === 'response.created') events.push(event(context, responseId, model, 'request_start', { protocol: id }));
      continue;
    }
    if (object.type === 'response.output_text.delta') {
      const delta = object.delta || '';
      content += delta;
      if (delta) events.push(event(context, responseId, model, 'assistant_message', { delta }));
      continue;
    }
    if (object.type === 'response.reasoning_summary_text.delta' || object.type === 'response.reasoning_text.delta') {
      const delta = object.delta || '';
      reasoning += delta;
      if (delta) events.push(event(context, responseId, model, 'reasoning', { delta, kind: object.type }));
      continue;
    }
    if (object.type === 'response.output_item.added' && object.item?.type === 'function_call') {
      toolCalls.set(toolKey(object), {
        id: object.item.call_id || object.item.id || '',
        name: object.item.name || '',
        arguments: object.item.arguments || '',
      });
      continue;
    }
    if (object.type === 'response.function_call_arguments.delta') {
      const key = toolKey(object);
      const call = toolCalls.get(key) || { id: object.call_id || object.item_id || '', name: object.name || '', arguments: '' };
      call.arguments += object.delta || '';
      toolCalls.set(key, call);
      continue;
    }
    if (object.type === 'response.output_item.done' && object.item?.type === 'function_call') {
      const key = toolKey(object);
      const call = toolCalls.get(key) || {
        id: object.item.call_id || object.item.id || '',
        name: object.item.name || '',
        arguments: object.item.arguments || '',
      };
      if (object.item.arguments) call.arguments = object.item.arguments;
      toolCalls.set(key, call);
      events.push(event(context, responseId, model, 'tool_call', normalizeToolCall(call)));
      continue;
    }
    if (object.type === 'response.completed') {
      responseId = object.response?.id || responseId;
      model = object.response?.model || model;
      usage = object.response?.usage || usage;
      if (usage) events.push(event(context, responseId, model, 'usage', usage));
      events.push(event(context, responseId, model, 'request_end', { complete: true }));
      continue;
    }
    if (object.type === 'response.failed' || object.type === 'error') {
      events.push(event(context, responseId, model, 'error', object.error || object.response?.error || object));
    }
  }

  return {
    id: responseId,
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
  const responseId = object.id || context.request_id || '';
  const model = object.model || context.model || '';
  const events = [event(context, responseId, model, 'request_start', { protocol: id, streaming: false })];
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  for (const item of Array.isArray(object.output) ? object.output : []) {
    if (item.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if ((block.type === 'output_text' || block.type === 'text') && block.text) {
          content += block.text;
          events.push(event(context, responseId, model, 'assistant_message', { text: block.text }));
        }
      }
    } else if (item.type === 'reasoning') {
      const text = (item.summary || []).map((block) => block.text || '').filter(Boolean).join('\n');
      if (text) {
        reasoning += text;
        events.push(event(context, responseId, model, 'reasoning', { text, kind: 'summary' }));
      }
    } else if (item.type === 'function_call') {
      const call = normalizeToolCall({ id: item.call_id || item.id, name: item.name, arguments: item.arguments || '' });
      toolCalls.push(call);
      events.push(event(context, responseId, model, 'tool_call', call));
    }
  }
  if (object.usage) events.push(event(context, responseId, model, 'usage', object.usage));
  if (object.error) events.push(event(context, responseId, model, 'error', object.error));
  events.push(event(context, responseId, model, 'request_end', { complete: !object.error && object.status !== 'failed' }));
  return { id: responseId, model, usage: object.usage || null, content, reasoning, toolCalls, chunkCount: 1, apiFormat: id, events };
}

function toolKey(object) {
  return object.item_id || object.item?.id || object.call_id || object.output_index || '0';
}

function normalizeToolCall(call) {
  let input = {};
  try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = call.arguments; }
  return { id: call.id || '', name: call.name || '', arguments: call.arguments || '', input };
}

function event(context, requestId, model, type, content) {
  return createEvent({
    ...context,
    request_id: requestId || context.request_id,
    model,
    provider: context.provider || 'openai',
    event_type: type,
    content,
    source: context.source || 'proxy',
  });
}

module.exports = { detect, displayName, id, parseJSON, parseSSE };
