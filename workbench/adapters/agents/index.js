const { adapter: claudeCode } = require('./claude-code');
const { adapter: codexCli } = require('./codex-cli');

const adapters = [claudeCode, codexCli];

function getAgentAdapter(id) {
  return adapters.find((adapter) => adapter.id === id) || null;
}

function validateAgentAdapter(adapter) {
  const methods = ['classifyRequest', 'discoverLocalSessions', 'historyToEvents', 'parseHistory'];
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (!adapter?.id || !adapter?.displayName || missing.length) {
    throw new Error(`Invalid agent adapter ${adapter?.id || '<unknown>'}; missing: ${missing.join(', ')}`);
  }
  return true;
}

for (const adapter of adapters) validateAgentAdapter(adapter);

module.exports = { adapters, getAgentAdapter, validateAgentAdapter };
