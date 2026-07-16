const anthropicMessages = require('./anthropic-messages');
const openaiResponses = require('./openai-responses');

const adapters = [anthropicMessages, openaiResponses];

function validateProtocolAdapter(adapter) {
  const methods = ['detect', 'parseJSON', 'parseSSE'];
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (!adapter?.id || !adapter?.displayName || missing.length) {
    throw new Error(`Invalid protocol adapter ${adapter?.id || '<unknown>'}; missing: ${missing.join(', ')}`);
  }
  return true;
}

for (const adapter of adapters) validateProtocolAdapter(adapter);

function detectProtocol(raw) {
  const first = anthropicMessages.parseDataObjects(raw)[0] || {};
  return adapters.find((adapter) => adapter.detect(first)) || null;
}

function parseSSE(raw, context = {}) {
  const adapter = detectProtocol(raw);
  if (!adapter) return unknownResult(raw);
  return adapter.parseSSE(raw, context);
}

function parseJSON(protocolId, input, context = {}) {
  const adapter = adapters.find((candidate) => candidate.id === protocolId);
  if (!adapter) throw new Error(`Unknown protocol adapter: ${protocolId}`);
  return adapter.parseJSON(input, context);
}

function unknownResult(raw) {
  return {
    id: '',
    model: '',
    usage: null,
    content: '',
    reasoning: '',
    toolCalls: [],
    chunkCount: anthropicMessages.parseDataObjects(raw).length,
    apiFormat: 'unknown',
    events: [],
  };
}

module.exports = { adapters, detectProtocol, parseJSON, parseSSE, validateProtocolAdapter };
