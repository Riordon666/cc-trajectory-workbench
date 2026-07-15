const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeCode = require('../workbench/adapters/agents/claude-code');

test('Claude Code adapter parses a synthetic history and preserves unavailable reasoning', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.jsonl');
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'synthetic question' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', model: 'claude-synthetic-test-model', content: [{ type: 'text', text: 'synthetic answer' }] } },
  ];
  fs.writeFileSync(file, `${lines.map(JSON.stringify).join('\n')}\n`);
  const rounds = claudeCode.parseHistory(file);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].assistantContent, 'synthetic answer');
  assert.equal(rounds[0].thinkingText, '');
  const events = claudeCode.historyToEvents(rounds, { session_id: 'synthetic' });
  assert.equal(events.some((event) => event.event_type === 'reasoning'), false);
});
