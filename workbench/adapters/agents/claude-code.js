const fs = require('fs');
const path = require('path');
const { createEvent } = require('../../core/event-schema');

const SYSTEM_PROMPT_ANCHOR = "You are Claude Code, Anthropic's official CLI for Claude.";
const MIN_MAIN_SYSTEM_PROMPT_CHARS = 4000;

function isMainRequest(body) {
  if (!body || typeof body !== 'object') return false;
  const system = Array.isArray(body.system) ? body.system : [];
  const anchorIndex = system.findIndex((block) => {
    const text = typeof block === 'string' ? block : block?.text;
    return String(text || '').toLowerCase() === SYSTEM_PROMPT_ANCHOR.toLowerCase();
  });
  if (anchorIndex === -1) return false;
  return textFromContent(system.slice(anchorIndex + 1)).length >= MIN_MAIN_SYSTEM_PROMPT_CHARS;
}

function classifyRequest(request = {}) {
  const body = request.request?.body || request.body;
  if (isMainRequest(body)) return 'main';
  const text = textFromContent(body?.messages?.at?.(-1)?.content);
  if (/summari[sz]e|conversation summary|recap/i.test(text)) return 'side-summary';
  if (/title|short label/i.test(text)) return 'side-title';
  return 'side-other';
}

function parseHistory(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const rounds = [];
  let currentUser = '';
  let currentToolResults = [];
  let currentAssistant = null;

  function flushAssistant() {
    if (!currentAssistant) return;
    rounds.push({
      index: rounds.length,
      userContent: currentUser,
      toolResults: currentToolResults,
      assistantContent: currentAssistant.text.trim(),
      thinkingText: currentAssistant.thinking.trim(),
      signature: currentAssistant.signature || '',
      toolUses: currentAssistant.toolUses,
      modelId: currentAssistant.modelId || '',
      provider: currentAssistant.provider || '',
      usage: currentAssistant.usage || null,
      ts: currentAssistant.ts || null,
      rawUuids: currentAssistant.rawUuids,
    });
    currentAssistant = null;
    currentToolResults = [];
  }

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'user') {
      if (currentAssistant) {
        flushAssistant();
        currentUser = '';
        currentToolResults = [];
      }
      const message = entry.message || {};
      const userText = textFromUserContent(message.content);
      if (userText) currentUser = currentUser ? `${currentUser}\n${userText}` : userText;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') {
          currentToolResults.push({
            tool_use_id: block.tool_use_id || '',
            content: typeof block.content === 'string' ? block.content : textFromContent(block.content),
          });
        }
      }
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const message = entry.message || {};
    if (entry.isApiErrorMessage || message.model === '<synthetic>') continue;
    if (!currentAssistant) {
      currentAssistant = {
        text: '', thinking: '', signature: '', toolUses: [],
        modelId: message.model || '', provider: message.provider || '',
        usage: message.usage || null, ts: entry.timestamp || null, rawUuids: [],
      };
    }
    currentAssistant.rawUuids.push(entry.uuid);
    currentAssistant.modelId ||= message.model || '';
    currentAssistant.provider ||= message.provider || '';
    currentAssistant.usage ||= message.usage || null;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'text') currentAssistant.text += `${currentAssistant.text ? '\n' : ''}${block.text || ''}`;
      if (block.type === 'thinking') {
        currentAssistant.thinking += `${currentAssistant.thinking ? '\n' : ''}${block.thinking || block.text || ''}`;
        currentAssistant.signature ||= block.signature || '';
      }
      if (block.type === 'tool_use') currentAssistant.toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  flushAssistant();
  return rounds;
}

function historyToEvents(rounds, context = {}) {
  const events = [];
  for (const round of rounds) {
    const base = {
      ...context,
      agent: id,
      provider: round.provider || context.provider || 'anthropic',
      model: round.modelId || context.model || '',
      request_id: round.rawUuids?.[0] || `${context.session_id || 'session'}:${round.index}`,
      timestamp: round.ts,
      source: 'agent-history',
    };
    if (round.userContent) events.push(createEvent({ ...base, event_type: 'user_message', content: { text: round.userContent } }));
    for (const result of round.toolResults || []) events.push(createEvent({ ...base, event_type: 'tool_result', content: result }));
    if (round.thinkingText) {
      events.push(createEvent({
        ...base,
        event_type: 'reasoning',
        content: { text: round.thinkingText, signature: round.signature || null },
      }));
    }
    for (const tool of round.toolUses || []) events.push(createEvent({ ...base, event_type: 'tool_call', content: tool }));
    if (round.assistantContent) events.push(createEvent({ ...base, event_type: 'assistant_message', content: { text: round.assistantContent } }));
    if (round.usage) events.push(createEvent({ ...base, event_type: 'usage', content: round.usage }));
  }
  return events;
}

function discoverLocalSessions() {
  const roots = [
    path.join(process.env.USERPROFILE || '', '.claude', 'projects'),
    path.join(process.env.HOME || '', '.claude', 'projects'),
  ].filter(Boolean);
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && !seen.has(file)) {
          seen.add(file);
          const stat = fs.statSync(file);
          files.push({
            path: file,
            project: path.basename(path.dirname(file)),
            sessionId: path.basename(file, '.jsonl'),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
    }
  }
  return files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, 20);
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result') return `[tool_result ${block.tool_use_id || ''}] ${textFromContent(block.content)}`;
    return '';
  }).filter(Boolean).join('\n');
}

function textFromUserContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((block) => typeof block === 'string' ? block : block.type === 'text' ? block.text || '' : '')
    .filter(Boolean).join('\n');
}

const id = 'claude-code';
const adapter = {
  id,
  displayName: 'Claude Code',
  protocols: ['anthropic-messages'],
  classifyRequest,
  discoverLocalSessions,
  historyToEvents,
  isMainRequest,
  parseHistory,
};

module.exports = { ...adapter, adapter };
