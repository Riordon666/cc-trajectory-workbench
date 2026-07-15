const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSSE } = require('../workbench/adapters/protocols');

function sse(objects) {
  return objects.map((object) => `data: ${JSON.stringify(object)}\n\n`).join('');
}

test('Anthropic Messages adapter emits normalized message, reasoning, tool and usage events', () => {
  const raw = sse([
    { type: 'message_start', message: { id: 'msg-synthetic', model: 'claude-synthetic-test-model', usage: { input_tokens: 2 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic reasoning' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
  const result = parseSSE(raw, { session_id: 'synthetic', agent: 'claude-code', source: 'fixture' });
  assert.equal(result.apiFormat, 'anthropic-messages');
  assert.equal(result.content, 'done');
  assert.equal(result.reasoning, 'synthetic reasoning');
  assert.deepEqual(result.toolCalls[0].input, { path: 'fixture.txt' });
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
  assert.ok(result.events.some((event) => event.event_type === 'reasoning'));
});

test('OpenAI Responses adapter never invents reasoning when the stream omits it', () => {
  const raw = sse([
    { type: 'response.created', response: { id: 'resp-synthetic', model: 'gpt-synthetic-test-model' } },
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.completed', response: { id: 'resp-synthetic', model: 'gpt-synthetic-test-model', usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  const result = parseSSE(raw, { session_id: 'synthetic', agent: 'unknown', source: 'fixture' });
  assert.equal(result.apiFormat, 'openai-responses');
  assert.equal(result.reasoning, '');
  assert.equal(result.events.some((event) => event.event_type === 'reasoning'), false);
});

test('non-stream Anthropic and OpenAI responses are normalized', () => {
  const anthropic = require('../workbench/adapters/protocols/anthropic-messages').parseJSON({ id: 'm1', model: 'claude-synthetic', content: [{ type: 'text', text: 'answer' }], usage: { output_tokens: 1 } }, { session_id: 's' });
  const openai = require('../workbench/adapters/protocols/openai-responses').parseJSON({ id: 'r1', model: 'gpt-synthetic', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] }, { session_id: 's' });
  assert.equal(anthropic.content, 'answer');
  assert.equal(openai.content, 'answer');
  assert.equal(openai.reasoning, '');
});

test('partial streams retain observed deltas without claiming request completion', () => {
  const result = parseSSE(sse([{ type: 'response.created', response: { id: 'partial', model: 'gpt-synthetic' } }, { type: 'response.output_text.delta', delta: 'partial' }]), { session_id: 's' });
  assert.equal(result.content, 'partial');
  assert.equal(result.events.some((event) => event.event_type === 'request_end'), false);
});
