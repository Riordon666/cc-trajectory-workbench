const test = require('node:test');
const assert = require('node:assert/strict');
const { alignRecords, toolComparison } = require('../workbench/lib/aligner');

function detail(proxy, client, confidence) {
  return { proxyIndex: proxy.seqIndex, clientRound: client.index, confidence, checks: { matched: true } };
}

test('does not align unrelated empty-text tool rounds', () => {
  const proxy = [{ seqIndex: 0, responseContent: '', responseToolCalls: [{ id: 'a', name: 'Read', arguments: '{"file":"a"}' }] }];
  const client = [{ index: 0, assistantContent: '', toolUses: [{ id: 'b', name: 'Bash', input: { command: 'test' } }] }];
  const result = alignRecords(proxy, client, detail);
  assert.equal(result[0].checks.matched, false);
});

test('aligns empty-text tool rounds only when full structure matches', () => {
  const proxy = [{ seqIndex: 0, responseContent: '', responseToolCalls: [{ id: 'a', name: 'Read', arguments: '{"file":"a"}' }] }];
  const client = [{ index: 0, assistantContent: '', toolUses: [{ id: 'a', name: 'Read', input: { file: 'a' } }] }];
  const result = alignRecords(proxy, client, detail);
  assert.equal(result[0].checks.matched, true);
});

test('tool comparison preserves order, ids, duplicates and arguments', () => {
  const equal = toolComparison(
    [{ id: '1', name: 'Read', arguments: '{"b":2,"a":1}' }],
    [{ id: '1', name: 'Read', input: { a: 1, b: 2 } }],
  );
  assert.equal(equal.structureMatch, true);
  const changed = toolComparison(
    [{ id: '1', name: 'Read', arguments: '{"a":1}' }],
    [{ id: '2', name: 'Read', input: { a: 1 } }],
  );
  assert.equal(changed.structureMatch, false);
});
