const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../workbench/adapters/agents/codex-cli');

function fixtureFile(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000001.jsonl');
  fs.writeFileSync(file, `${entries.map(JSON.stringify).join('\n')}\n`);
  return file;
}

test('Codex rollout-v1 maps real observed shapes to generic events', (t) => {
  const file = fixtureFile(t, [
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { session_id: 'synthetic-session', cli_version: '0.0-test', model_provider: 'openai', cwd: 'C:\\synthetic' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-synthetic-complete-model-name' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'synthetic question' } },
    { timestamp: '2026-01-01T00:00:04Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary only' }], encrypted_content: 'not-a-real-secret' } },
    { timestamp: '2026-01-01T00:00:05Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"echo synthetic"}' } },
    { timestamp: '2026-01-01T00:00:06Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'synthetic output' } },
    { timestamp: '2026-01-01T00:00:07Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic answer' }] } },
    { timestamp: '2026-01-01T00:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]);
  const parsed = codex.parseHistory(file);
  const events = codex.historyToEvents(parsed);
  assert.equal(parsed.formatVersion, 'rollout-v1');
  assert.ok(events.some((event) => event.event_type === 'reasoning' && event.content.kind === 'summary'));
  assert.equal(events.find((event) => event.event_type === 'assistant_message').model, 'gpt-synthetic-complete-model-name');
  assert.ok(events.some((event) => event.event_type === 'tool_call'));
  assert.ok(events.some((event) => event.event_type === 'tool_result'));
});

test('Codex rollout-v0 compatibility does not invent reasoning', (t) => {
  const file = fixtureFile(t, [
    { timestamp: '2025-01-01T00:00:00Z', type: 'message', role: 'user', content: 'old question', model: 'gpt-old-synthetic-model' },
    { timestamp: '2025-01-01T00:00:01Z', type: 'message', role: 'assistant', content: 'old answer', model: 'gpt-old-synthetic-model' },
  ]);
  const parsed = codex.parseHistory(file);
  const events = codex.historyToEvents(parsed, { session_id: 'legacy-synthetic' });
  assert.equal(parsed.formatVersion, 'rollout-v0');
  assert.equal(events.some((event) => event.event_type === 'reasoning'), false);
});
