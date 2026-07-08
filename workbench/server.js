const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const CERT_DIR = path.join(ROOT, 'certs');
const HOST = '127.0.0.1';
const PORT = parseInt(process.env.WORKBENCH_PORT || '5177', 10);
const MAX_JSON_TEXT_BYTES = 450 * 1024 * 1024;
const SYSTEM_PROMPT_ANCHOR = "You are Claude Code, Anthropic's official CLI for Claude.";
const MIN_MAIN_SYSTEM_PROMPT_CHARS = 4000;

let proxyProcess = null;
let setupProcess = null;
let proxySessionId = null;
const logs = [];

function log(line) {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  logs.push(entry);
  if (logs.length > 800) logs.shift();
  console.log(entry);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSessionId(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id || '')) throw httpError(400, 'Invalid session id');
  return id;
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, safeSessionId(id));
}

function assertInsideSessions(dir) {
  const resolved = path.resolve(dir);
  const root = path.resolve(SESSIONS_DIR);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw httpError(400, 'Path is outside sessions directory');
  }
  return resolved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) reject(httpError(413, 'Request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'Invalid JSON body'));
      }
    });
  });
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.resolve(PUBLIC_DIR, cleanPath.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function listSessions() {
  ensureDir(SESSIONS_DIR);
  return fs.readdirSync(SESSIONS_DIR)
    .filter((name) => fs.statSync(path.join(SESSIONS_DIR, name)).isDirectory())
    .map((id) => {
      const dir = sessionDir(id);
      const configPath = path.join(dir, 'config.json');
      const config = fs.existsSync(configPath) ? readJson(configPath) : {};
      return {
        id,
        name: config.name || id,
        createdAt: config.createdAt,
        path: dir,
        hasIntercepts: fs.existsSync(path.join(dir, 'https-intercepts.json')),
        hasHistory: fs.existsSync(path.join(dir, 'claude-history.jsonl')),
        hasVerification: fs.existsSync(path.join(dir, 'verification-result.json')),
        hasDelivery: fs.existsSync(path.join(dir, 'instance.json')) && fs.existsSync(path.join(dir, 'trajectory.jsonl')),
      };
    })
    .sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
}

function renameSession(id, name) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) throw httpError(404, 'Session not found');
  const newName = String(name || id).trim();
  if (!newName || newName === id) return { id, config: { id, name: newName } };
  // 重命名目录
  const newDir = path.join(SESSIONS_DIR, newName);
  assertInsideSessions(newDir);
  if (fs.existsSync(newDir)) throw httpError(409, 'Session name already exists');
  fs.renameSync(dir, newDir);
  // 更新 config
  const configPath = path.join(newDir, 'config.json');
  const config = fs.existsSync(configPath) ? readJson(configPath) : { id: newName, createdAt: new Date().toISOString() };
  config.id = newName;
  config.name = newName;
  writeJson(configPath, config);
  // 如果正在代理此 session，更新引用
  if (proxySessionId === id) proxySessionId = newName;
  log(`Renamed session ${id} → ${newName}`);
  return { id: newName, config };
}

function deleteSession(id) {
  if (proxySessionId === id && proxyProcess) throw httpError(409, 'Stop proxy before deleting this session');
  const dir = assertInsideSessions(sessionDir(id));
  if (!fs.existsSync(dir)) throw httpError(404, 'Session not found');
  fs.rmSync(dir, { recursive: true, force: true });
  log(`Deleted session ${id}`);
  return { ok: true };
}

function createSession(name) {
  ensureDir(SESSIONS_DIR);
  const nameInput = String(name || '').trim();
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const id = nameInput || stamp;
  const dir = sessionDir(id);
  if (fs.existsSync(dir)) throw httpError(409, 'Session 已存在');
  ensureDir(dir);
  const config = {
    id,
    name: name || id,
    createdAt: new Date().toISOString(),
    proxyPort: 8888,
    targetHost: '',
  };
  writeJson(path.join(dir, 'config.json'), config);
  log(`Created session ${id}`);
  return { id, path: dir, config };
}

function copyIntoSession(source, target) {
  if (!source || !fs.existsSync(source)) throw httpError(400, `File not found: ${source}`);
  fs.copyFileSync(source, target);
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    ...usage,
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result') return `[tool_result ${block.tool_use_id || ''}] ${block.content || ''}`;
    return '';
  }).filter(Boolean).join('\n');
}

function textFromUserContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    return '';
  }).filter(Boolean).join('\n');
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeTrajectoryContent(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return cloneJsonValue(content);
  return cloneJsonValue(content);
}

const CROSS_TASK_MEMORY_PATTERNS = [
  /PUBG/i,
  /pubg-crash/i,
  /崩溃记录/,
];

function sanitizeCrossTaskMemoryText(text) {
  const value = String(text || '');
  // 无命中时原样返回，保留原始行尾（\r\n），保证 tool_result 与 claude-history.jsonl 完全一致。
  if (!CROSS_TASK_MEMORY_PATTERNS.some((pattern) => pattern.test(value))) return value;
  return value
    .split(/\r?\n/)
    .filter((line) => !CROSS_TASK_MEMORY_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n');
}

function sanitizeCrossTaskMemoryContent(content) {
  if (typeof content === 'string') return sanitizeCrossTaskMemoryText(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const sanitized = { ...block };
    if (typeof sanitized.text === 'string') {
      sanitized.text = sanitizeCrossTaskMemoryText(sanitized.text);
    }
    if (typeof sanitized.content === 'string') {
      sanitized.content = sanitizeCrossTaskMemoryText(sanitized.content);
    }
    return sanitized;
  });
}

function normalizeThinkingKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function dedupeThinkingBlocks(content, seenThinking) {
  if (!Array.isArray(content)) return content;
  const filtered = [];
  for (const block of content) {
    if (block?.type !== 'thinking') {
      filtered.push(block);
      continue;
    }
    const key = normalizeThinkingKey(block.thinking);
    if (!key) {
      filtered.push(block);
      continue;
    }
    const existing = seenThinking.get(key);
    if (existing) {
      if (!existing.signature && block.signature) existing.signature = block.signature;
      continue;
    }
    seenThinking.set(key, block);
    filtered.push(block);
  }
  return filtered;
}

function isInjectedContextText(text) {
  const value = String(text || '').trimStart();
  return value.startsWith('<system-reminder>')
    || value.startsWith('<local-command-caveat>')
    || value.startsWith('<user-prompt-submit-hook>');
}

function hasInjectedUserContext(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'text'
    && isInjectedContextText(block.text));
}

function systemPromptToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return textFromContent(system);
  return JSON.stringify(system);
}

function jsonBraceDelta(line) {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === '{') delta++;
    if (!inString && ch === '}') delta--;
  }
  return delta;
}

function* readDataEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(1024 * 1024);
  let leftover = '';
  let inData = false;
  let collecting = false;
  let depth = 0;
  let entry = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      const chunk = bytesRead ? decoder.write(buffer.slice(0, bytesRead)) : decoder.end();
      if (!bytesRead && leftover) {
        const finalLine = leftover;
        leftover = '';
        const lines = [finalLine];
        for (const line of lines) {
          if (!inData) {
            if (line.trim() === '"data": [') inData = true;
            continue;
          }
          if (!collecting) {
            if (line.startsWith('    {')) {
              collecting = true;
              depth = 0;
              entry = '';
            } else if (line.startsWith('  ]')) {
              return;
            } else {
              continue;
            }
          }
          entry += `${line}\n`;
          depth += jsonBraceDelta(line);
          if (collecting && depth === 0) {
            collecting = false;
            const trimmed = entry.trimEnd().replace(/,$/, '');
            yield trimmed;
            entry = '';
          }
        }
      }
      if (!chunk && !bytesRead) break;
      const lines = (leftover + chunk).split(/\r?\n/);
      leftover = bytesRead ? lines.pop() || '' : '';
      for (const line of lines) {
        if (!inData) {
          if (line.trim() === '"data": [' || line.trim() === '"data": [') inData = true;
          continue;
        }
        if (!collecting) {
          if (line.startsWith('    {')) {
            collecting = true;
            depth = 0;
            entry = '';
          } else if (line.startsWith('  ]')) {
            return;
          } else {
            continue;
          }
        }
        entry += `${line}\n`;
        depth += jsonBraceDelta(line);
        if (collecting && depth === 0) {
          collecting = false;
          const trimmed = entry.trimEnd().replace(/,$/, '');
          yield trimmed;
          entry = '';
        }
      }
      if (!bytesRead) break;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  const userMessages = messages.filter((m) => m.role === 'user');
  return userMessages[userMessages.length - 1] || null;
}

function isMainClaudeCodeRequest(body) {
  if (!body || typeof body !== 'object') return false;
  const system = Array.isArray(body.system) ? body.system : [];
  const anchorIndex = system.findIndex((block) => {
    const text = typeof block === 'string' ? block : block?.text;
    return String(text || '').toLowerCase() === SYSTEM_PROMPT_ANCHOR.toLowerCase();
  });
  if (anchorIndex === -1) return false;
  const promptText = textFromContent(system.slice(anchorIndex + 1));
  return promptText.length >= MIN_MAIN_SYSTEM_PROMPT_CHARS;
}

function extractMainRequestUserContents(filePath) {
  const records = [];
  for (const rawEntry of readDataEntries(filePath)) {
    let entry = null;
    try {
      entry = JSON.parse(rawEntry);
    } catch {
      continue;
    }
    const body = entry.request?.body;
    if (
      entry.method !== 'POST'
      || entry.response?.status < 200
      || entry.response?.status >= 300
      || !isMainClaudeCodeRequest(body)
    ) {
      continue;
    }
    const lastUser = getLastUserMessage(body.messages);
    const content = normalizeTrajectoryContent(lastUser?.content);
    records.push({
      id: entry.id,
      requestModel: body.model || '',
      content,
    });
  }
  return records;
}

function extractMainRequestContext(filePath, firstUserContent = '') {
  const firstUserText = String(firstUserContent || '').trim();
  let fallback = null;

  for (const rawEntry of readDataEntries(filePath)) {
    let entry = null;
    try {
      entry = JSON.parse(rawEntry);
    } catch {
      continue;
    }
    const body = entry.request?.body;
    if (
      entry.method !== 'POST'
      || entry.response?.status < 200
      || entry.response?.status >= 300
      || !isMainClaudeCodeRequest(body)
    ) {
      continue;
    }
    const lastUser = getLastUserMessage(body.messages);
    const lastUserText = textFromContent(lastUser?.content);
    const system = normalizeTrajectoryContent(body.system);
    const tools = normalizeTrajectoryContent(body.tools || []);
    const context = {
      id: entry.id,
      requestModel: body.model || '',
      system,
      tools,
      systemChars: textFromContent(system).length,
      toolsCount: Array.isArray(tools) ? tools.length : 0,
    };
    if (!fallback) fallback = context;
    if (!firstUserText || lastUserText.includes(firstUserText)) return context;
  }

  return fallback;
}

function parseIntercepts(filePath) {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize > MAX_JSON_TEXT_BYTES) {
    return {
      raw: {},
      records: [],
      skipped: true,
      skipReason: `https-intercepts.json is too large to parse safely (${formatBytes(fileSize)}).`,
      stats: {
        totalInterceptions: 0,
        totalChatRequests: 0,
        failedRequests: 0,
        successfulRequests: 0,
        targetHost: '',
      },
    };
  }
  const raw = readJson(filePath);
  const all = (raw.data || []).filter((d) =>
    d.method === 'POST'
    && typeof d.request?.body === 'object'
    && d.request.body !== null
    && (Array.isArray(d.request.body.messages) || d.path?.includes('/messages'))
    && (d.path?.includes('/chat/completions') || d.path?.includes('/messages'))
  );
  const failed = all.filter((d) => d.response?.status < 200 || d.response?.status >= 300);
  const successful = all.filter((d) => d.response?.status >= 200 && d.response?.status < 300);

  const records = successful.map((d, index) => {
    const req = d.request.body || {};
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    const systemMessage = messages.find((m) => m.role === 'system');
    const responseParsed = d.response?.parsed || {};
    return {
      id: d.id,
      seqIndex: index,
      timestamp: d.timestamp,
      method: d.method,
      path: d.path,
      url: d.url,
      status: d.response?.status,
      duration: d.duration,
      requestModel: req.model || '',
      responseModel: responseParsed.model || '',
      messageCount: messages.length,
      hasSystemPrompt: Boolean(req.system || systemMessage),
      systemPrompt: systemPromptToText(req.system) || textFromContent(systemMessage?.content),
      userContent: textFromContent(lastUser?.content),
      userContentBlocks: normalizeTrajectoryContent(lastUser?.content),
      responseContent: responseParsed.content || '',
      responseReasoning: responseParsed.reasoning || '',
      responseToolCalls: responseParsed.toolCalls || [],
      usage: normalizeUsage(responseParsed.usage),
      raw: d,
    };
  });

  return {
    raw,
    records,
    stats: {
      totalInterceptions: raw.totalInterceptions || (raw.data || []).length,
      totalChatRequests: all.length,
      failedRequests: failed.length,
      successfulRequests: records.length,
      targetHost: raw.targetHost || '',
    },
  };
}

function getInterceptDetail(id, seqIndex) {
  const file = path.join(sessionDir(id), 'https-intercepts.json');
  if (!fs.existsSync(file)) throw httpError(404, 'No intercepts file in session');
  const parsed = parseIntercepts(file);
  const record = parsed.records.find((r) => r.seqIndex === Number(seqIndex));
  if (!record) throw httpError(404, 'Intercept record not found');
  return {
    seqIndex: record.seqIndex,
    timestamp: record.timestamp,
    method: record.method,
    path: record.path,
    url: record.url,
    status: record.status,
    duration: record.duration,
    requestModel: record.requestModel,
    responseModel: record.responseModel,
    messageCount: record.messageCount,
    hasSystemPrompt: record.hasSystemPrompt,
    systemPrompt: record.systemPrompt,
    userContent: record.userContent,
    responseContent: record.responseContent,
    responseReasoning: record.responseReasoning,
    responseToolCalls: record.responseToolCalls,
    usage: record.usage,
  };
}

function parseClaudeHistory(filePath) {
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
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'user') {
      if (currentAssistant) {
        flushAssistant();
        currentUser = '';
        currentToolResults = [];
      }
      const msg = entry.message || {};
      const userText = textFromUserContent(msg.content);
      if (userText) currentUser = currentUser ? `${currentUser}\n${userText}` : userText;
      // 提取结构化的 tool_result；连续 user 事件在下一条 assistant 前属于同一轮。
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            currentToolResults.push({
              tool_use_id: block.tool_use_id || '',
              content: typeof block.content === 'string' ? block.content : textFromContent(block.content),
            });
          }
        }
      }
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message || {};
    if (entry.isApiErrorMessage || msg.model === '<synthetic>') continue;
    if (!currentAssistant) {
      currentAssistant = {
        text: '',
        thinking: '',
        signature: '',
        toolUses: [],
        modelId: msg.model || '',
        provider: msg.provider || '',
        usage: msg.usage || null,
        ts: entry.timestamp || null,
        rawUuids: [],
      };
    }
    currentAssistant.rawUuids.push(entry.uuid);
    currentAssistant.modelId ||= msg.model || '';
    currentAssistant.provider ||= msg.provider || '';
    currentAssistant.usage ||= msg.usage || null;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
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

function commonPrefixMatch(a, b, n = 100) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left && !right) return true;
  if (!left || !right) return false;
  const len = Math.min(n, left.length, right.length);
  return left.slice(0, len) === right.slice(0, len);
}

function alignRecords(proxyRecords, clientRounds) {
  const details = [];
  let cursor = 0;
  for (const proxy of proxyRecords) {
    let best = null;
    for (let i = cursor; i < clientRounds.length; i++) {
      const client = clientRounds[i];
      const proxyTools = proxy.responseToolCalls.map((t) => t.name).sort().join(',');
      const clientTools = client.toolUses.map((t) => t.name).sort().join(',');
      const textMatch = commonPrefixMatch(proxy.responseContent, client.assistantContent);
      const toolMatch = proxyTools === clientTools;
      if (textMatch || (!proxy.responseContent && !client.assistantContent && toolMatch)) {
        best = { client, index: i, confidence: textMatch && toolMatch ? 0.95 : 0.78 };
        break;
      }
    }
    if (best) {
      cursor = best.index + 1;
      details.push(makeDetail(proxy, best.client, best.confidence));
    } else {
      details.push({ proxyIndex: proxy.seqIndex, clientRound: null, confidence: 0, checks: { matched: false } });
    }
  }
  return details;
}

function makeDetail(proxy, client, confidence) {
  const proxyTools = proxy.responseToolCalls.map((t) => t.name).sort();
  const clientTools = client.toolUses.map((t) => t.name).sort();
  const responseMatch = commonPrefixMatch(proxy.responseContent, client.assistantContent);
  return {
    proxyIndex: proxy.seqIndex,
    clientRound: client.index,
    confidence,
    proxyTime: proxy.timestamp,
    checks: {
      matched: true,
      userContentMatch: commonPrefixMatch(proxy.userContent, client.userContent, 160),
      responseMatch,
      modelMatch: !client.modelId || proxy.requestModel === client.modelId || proxy.responseModel === client.modelId,
      proxyModel: proxy.requestModel,
      clientModel: client.modelId,
      actualModel: proxy.responseModel,
      responseToolMatch: JSON.stringify(proxyTools) === JSON.stringify(clientTools),
      proxyResponseTools: proxyTools,
      clientResponseTools: clientTools,
      thinkingInfo: {
        clientHasThinking: Boolean(client.thinkingText),
        clientThinkingLength: client.thinkingText.length,
        proxyHasReasoning: Boolean(proxy.responseReasoning),
        proxyReasoningLength: proxy.responseReasoning.length,
      },
    },
  };
}

function verifySession(id) {
  const dir = sessionDir(id);
  const interceptFile = path.join(dir, 'https-intercepts.json');
  const historyFile = path.join(dir, 'claude-history.jsonl');
  if (!fs.existsSync(interceptFile)) throw httpError(400, 'Session is missing https-intercepts.json');
  if (!fs.existsSync(historyFile)) throw httpError(400, 'Session is missing claude-history.jsonl');

  const intercepts = parseIntercepts(interceptFile);
  const rounds = parseClaudeHistory(historyFile);
  const details = alignRecords(intercepts.records, rounds);
  const matched = details.filter((d) => d.checks?.matched).length;
  const summary = {
    proxyIntercepts: intercepts.records.length,
    totalRequests: intercepts.stats.totalChatRequests,
    failedRequests: intercepts.stats.failedRequests,
    clientRounds: rounds.length,
    matched,
    responseOk: details.filter((d) => d.checks?.responseMatch).length,
    modelOk: details.filter((d) => d.checks?.modelMatch).length,
    toolMatchOk: details.filter((d) => d.checks?.responseToolMatch).length,
    thinking: {
      clientThinkingRounds: details.filter((d) => d.checks?.thinkingInfo?.clientHasThinking).length,
      proxyReasoningRounds: details.filter((d) => d.checks?.thinkingInfo?.proxyHasReasoning).length,
    },
  };
  summary.allGood = matched > 0
    && summary.responseOk === matched
    && summary.modelOk === matched
    && summary.toolMatchOk === matched;

  const result = {
    timestamp: new Date().toISOString(),
    clientType: 'claude',
    inputFiles: {
      intercepts: interceptFile,
      history: historyFile,
      interceptsSha256: hashFile(interceptFile),
      historySha256: hashFile(historyFile),
    },
    summary,
    details,
  };
  writeJson(path.join(dir, 'verification-result.json'), result);
  return result;
}

function detectLanguage(rounds) {
  const extMap = {
    '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.go': 'go', '.rs': 'rust', '.java': 'java', '.cpp': 'c++', '.c': 'c',
    '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
    '.scala': 'scala', '.sh': 'shell', '.bash': 'shell', '.sql': 'sql',
    '.html': 'html', '.css': 'css', '.vue': 'vue', '.svelte': 'svelte',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.md': 'markdown', '.dockerfile': 'dockerfile', '.tf': 'hcl',
  };
  const counts = {};
  for (const r of rounds) {
    for (const tu of r.toolUses || []) {
      const input = tu.input || {};
      const paths = [input.filePath, input.path, input.target_file, input.file_path, input.dest_path].filter(Boolean);
      for (const p of paths) {
        const ext = String(p).toLowerCase().match(/\.[a-z]+$/)?.[0];
        if (ext && extMap[ext]) counts[extMap[ext]] = (counts[extMap[ext]] || 0) + 1;
      }
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : '';
}

function selectDeliveryModel({ optionModel, mainRequestContext, firstProxy, rounds }) {
  const candidates = [
    optionModel,
    rounds.find((round) => round.modelId)?.modelId,
    mainRequestContext?.requestModel,
    firstProxy?.responseModel,
    firstProxy?.requestModel,
  ];
  return candidates.map((model) => String(model || '').trim()).find(Boolean) || 'manual-review-required';
}

function buildSummaryCot(rounds) {
  const thinkingRounds = rounds.filter((r) => r.thinkingText);
  if (!thinkingRounds.length) return '';
  const first = thinkingRounds[0].thinkingText.replace(/\s+/g, ' ').slice(0, 220);
  const last = thinkingRounds[thinkingRounds.length - 1].thinkingText.replace(/\s+/g, ' ').slice(0, 220);
  return `自动摘要草稿：本轨迹包含 ${rounds.length} 个 assistant 轮次，模型围绕真实编程任务进行分析、读取/执行工具调用并给出最终结论。起始推理要点：${first}${thinkingRounds.length > 1 ? `。后续推理要点：${last}` : ''}`;
}

function convertSession(id, options = {}) {
  const dir = sessionDir(id);
  const interceptFile = path.join(dir, 'https-intercepts.json');
  const historyFile = path.join(dir, 'claude-history.jsonl');
  const verificationFile = path.join(dir, 'verification-result.json');
  if (!fs.existsSync(interceptFile) || !fs.existsSync(historyFile)) {
    throw httpError(400, 'Import intercepts and Claude Code history before conversion');
  }
  const intercepts = parseIntercepts(interceptFile);
  const rounds = parseClaudeHistory(historyFile);
  const verification = fs.existsSync(verificationFile) ? readJson(verificationFile) : verifySession(id);
  const proxyByIndex = new Map(intercepts.records.map((record) => [record.seqIndex, record]));
  const detailByClientRound = new Map((verification.details || [])
    .filter((detail) => detail.clientRound !== null && detail.clientRound !== undefined)
    .map((detail) => [detail.clientRound, detail]));
  const firstProxy = intercepts.records[0] || {};
  const observedTools = [...new Set(rounds.flatMap((r) => r.toolUses.map((t) => t.name)).filter(Boolean))];
  const taskId = options.task_id || `task_${id}`;
  const instanceId = options.instance_id || `swe_${taskId}_${crypto.randomBytes(3).toString('hex')}`;
  const firstRoundUserContent = rounds.length ? buildSOPContent(rounds[0], 'user') : '';
  const mainRequestContext = extractMainRequestContext(interceptFile, textFromContent(firstRoundUserContent));
  const selectedModel = selectDeliveryModel({
    optionModel: options.model,
    mainRequestContext,
    firstProxy,
    rounds,
  });

  // ── instance.json（SOP 格式）─────────────────────────
  const detectedLang = options.language || detectLanguage(rounds);
  const instance = {
    instance_id: instanceId,
    task_id: taskId,
    repo: options.repo || '',
    base_commit: options.base_commit || '',
    language: detectedLang,
    problem_statement: options.problem_statement || '',
    agent: options.agent || 'Claude Code',
    model: selectedModel,
    system: sanitizeCrossTaskMemoryContent(mainRequestContext?.system || []),
    tools: mainRequestContext?.tools || [],
  };

  // ── trajectory.jsonl（SOP 格式）───────────────────────
  const trajectoryLines = [];
  const summaryCotParts = [];
  const streamedUserContents = intercepts.skipped ? extractMainRequestUserContents(interceptFile) : [];
  const seenThinking = new Map();

  rounds.forEach((round, i) => {
    const detail = detailByClientRound.get(i);
    const proxyRecord = detail ? proxyByIndex.get(detail.proxyIndex) : null;
    const roundSig = round.signature || '';
    const streamedUserRecord = streamedUserContents[i] || null;

    // ── User 行 ────────────────────────────────────────
    // https-intercepts.json 只用于第一轮 user 的前置 system reminder/context；
    // 其余轮次一律以 claude-history.jsonl 为准，避免代理侧内容覆盖掉本轮 tool_result。
    const userContent = buildSOPContent(round, 'user', {
      proxyUserContent: i === 0 ? (proxyRecord?.userContentBlocks || streamedUserRecord?.content) : undefined,
    });
    trajectoryLines.push({
      role: 'user',
      model: selectedModel,
      content: sanitizeCrossTaskMemoryContent(userContent),
    });

    // ── Assistant 行 ────────────────────────────────────
    const asstContent = dedupeThinkingBlocks(buildSOPContent(round, 'assistant', {
      signature: roundSig,
    }), seenThinking);
    if (round.thinkingText) {
      summaryCotParts.push(round.thinkingText.replace(/\s+/g, ' ').slice(0, 200));
    }
    trajectoryLines.push({
      role: 'assistant',
      model: selectedModel,
      content: sanitizeCrossTaskMemoryContent(asstContent),
    });
  });

  // ── 写入文件 ────────────────────────────────────────
  const instancePath = path.join(dir, 'instance.json');
  const trajectoryPath = path.join(dir, 'trajectory.jsonl');
  writeJson(instancePath, instance);
  const previewLines = [];
  fs.writeFileSync(trajectoryPath, '');
  for (const line of trajectoryLines) {
    const serializedLine = JSON.stringify(line);
    if (previewLines.length < 8) previewLines.push(serializedLine);
    fs.appendFileSync(trajectoryPath, `${serializedLine}\n`);
  }

  const summaryCot = options.summary_cot || (
    summaryCotParts.length
      ? `自动摘要：${summaryCotParts.join('；')}`
      : ''
  );

  // 用于 QC 的内部记录
  const qc = qcDelivery({ instance, trajectoryLines, summaryCot, selectedModel });
  if (intercepts.skipped) {
    qc.warnings.push(intercepts.skipReason);
  }
  if (!mainRequestContext) {
    qc.warnings.push('未能从 https-intercepts.json 提取主请求 system/tools，instance.json 未写入 system/tools');
  } else {
    qc.info.push(`Main request context: intercept #${mainRequestContext.id}, system ${mainRequestContext.systemChars} chars, tools ${mainRequestContext.toolsCount}`);
  }
  const injectedUserLines = trajectoryLines.filter((line) => line.role === 'user' && hasInjectedUserContext(line.content)).length;
  qc.info.push(`Injected user context lines: ${injectedUserLines}`);
  writeJson(path.join(dir, 'qc-report.json'), qc);

  return {
    instance,
    qc,
    instancePath,
    trajectoryPath,
    preview: previewLines.join('\n'),
  };
}

// ── 构建 SOP content 格式 ──────────────────────────────
function buildSOPContent(round, role, opts = {}) {
  if (role === 'user') {
    if (hasInjectedUserContext(opts.proxyUserContent)) {
      return sanitizeCrossTaskMemoryContent(normalizeTrajectoryContent(opts.proxyUserContent));
    }
    // 检查是否有 tool_result
    if (round.toolResults && round.toolResults.length) {
      const blocks = [];
      if (round.userContent) blocks.push({ type: 'text', text: round.userContent });
      for (const tr of round.toolResults) {
        blocks.push({ type: 'tool_result', tool_use_id: tr.tool_use_id || '', content: tr.content || '' });
      }
      return blocks;
    }
    return round.userContent || '';
  }

  // Assistant 行
  const blocks = [];
  const thinkingText = round.thinkingText || '';
  if (thinkingText) {
    blocks.push({
      type: 'thinking',
      thinking: thinkingText,
      signature: opts.signature || round.signature || '',
    });
  }
  if (round.assistantContent) {
    blocks.push({ type: 'text', text: round.assistantContent });
  }
  for (const tu of round.toolUses || []) {
    blocks.push({ type: 'tool_use', id: tu.id || '', name: tu.name || '', input: tu.input || {} });
  }
  return blocks;
}

function qcDelivery({ instance, trajectoryLines, summaryCot, selectedModel }) {
  const errors = [];
  const warnings = [];
  const info = [];

  // ── instance.json 检查 ──────────────────────────────
  const requiredInstanceFields = ['instance_id', 'repo', 'base_commit', 'language', 'problem_statement', 'agent', 'model'];
  for (const field of requiredInstanceFields) {
    if (!instance[field]) errors.push(`instance.json 缺少必填字段: ${field}`);
  }

  // ── 模型检查 ───────────────────────────────────────
  if (instance.model === 'manual-review-required') {
    errors.push('未能从 claude-history.jsonl 或 https-intercepts.json 提取完整 model 名称');
  }

  // ── trajectory.jsonl 格式检查 ──────────────────────
  const userLines = trajectoryLines.filter((l) => l.role === 'user');
  const assistantLines = trajectoryLines.filter((l) => l.role === 'assistant');

  // 模型一致性
  const inconsistentModel = trajectoryLines.find((l) => l.model !== selectedModel);
  if (inconsistentModel) {
    errors.push('trajectory 中存在不一致的 model 字段（SOP 要求每条轨迹只用一种模型）');
  }

  // 每行可 JSON parse（写入时已验证，这里再确认）
  for (const line of trajectoryLines) {
    if (!line.role || !['user', 'assistant'].includes(line.role)) {
      errors.push('trajectory 行缺少有效 role 字段');
    }
    if (!line.model) errors.push('trajectory 行缺少 model 字段');
    if (line.content === undefined) errors.push('trajectory 行缺少 content 字段');
  }

  // ── thinking 块检查 ─────────────────────────────────
  let totalThinkingBlocks = 0;
  let missingSignatureCount = 0;
  let emptyThinkingCount = 0;
  for (const line of assistantLines) {
    const content = Array.isArray(line.content) ? line.content : [];
    for (const block of content) {
      if (block.type === 'thinking') {
        totalThinkingBlocks++;
        if (!block.signature) missingSignatureCount++;
        if (!block.thinking) emptyThinkingCount++;
      }
    }
  }
  if (totalThinkingBlocks === 0) {
    errors.push('整条轨迹没有任何 thinking 块（SOP 要求至少 1 个）');
  } else {
    if (missingSignatureCount > 0) errors.push(`${missingSignatureCount} 个 thinking 块缺少 signature`);
    if (emptyThinkingCount > 0) errors.push(`${emptyThinkingCount} 个 thinking 块的 thinking 文本为空`);
    info.push(`Thinking 块: ${totalThinkingBlocks} 个`);
  }

  // ── 工具调用检查 ───────────────────────────────────
  const allToolNames = new Set();
  for (const line of assistantLines) {
    const content = Array.isArray(line.content) ? line.content : [];
    for (const block of content) {
      if (block.type === 'tool_use') allToolNames.add(block.name);
    }
  }
  if (!allToolNames.size) {
    warnings.push('轨迹中没有任何工具调用（SOP 期望包含多种工具）');
  } else {
    info.push(`工具调用: [${[...allToolNames].join(', ')}]`);
    if (allToolNames.size < 2) warnings.push('工具调用类型较少，建议覆盖 ReadFile/WriteFile/RunCommand 等多种工具');
  }

  // ── CoT 检查 ────────────────────────────────────────
  const fullCotLength = assistantLines.reduce((sum, line) => {
    const content = Array.isArray(line.content) ? line.content : [];
    return sum + content.filter((b) => b.type === 'thinking').reduce((s, b) => s + String(b.thinking || '').length, 0);
  }, 0);
  const summaryLength = String(summaryCot || '').length;
  if (fullCotLength === 0) {
    errors.push('CoT 数据为空（全轨迹无 thinking 文本）');
  }
  if (summaryLength > 0 && fullCotLength <= summaryLength) {
    errors.push('完整 CoT 总长度不大于 summary_cot 长度');
  }
  info.push(`CoT 总字符: ${fullCotLength}; summary: ${summaryLength}`);
  info.push(`Assistant 轮次: ${assistantLines.length}`);

  // ── 敏感信息检查 ───────────────────────────────────
  const sensitivePatterns = [
    /sk-[A-Za-z0-9_-]{16,}/,
    /ANTHROPIC_API_KEY/i,
    /Authorization["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]+/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  const hasSensitive = sensitivePatterns.some((p) => p.test(JSON.stringify(instance)))
    || trajectoryLines.some((line) => {
      const serializedLine = JSON.stringify(line);
      return sensitivePatterns.some((p) => p.test(serializedLine));
    });
  if (hasSensitive) {
    warnings.push('检测到疑似敏感信息，交付前请审查');
  }

  return { timestamp: new Date().toISOString(), passed: errors.length === 0, errors, warnings, info };
}

function sessionOverview(id) {
  const dir = sessionDir(id);
  const files = ['config.json', 'https-intercepts.json', 'claude-history.jsonl', 'verification-result.json', 'instance.json', 'trajectory.jsonl', 'qc-report.json']
    .map((name) => {
      const file = path.join(dir, name);
      return { name, exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
    });
  let interceptSummary = null;
  if (fs.existsSync(path.join(dir, 'https-intercepts.json'))) {
    const parsed = parseIntercepts(path.join(dir, 'https-intercepts.json'));
    interceptSummary = parsed.stats;
  }
  let historySummary = null;
  if (fs.existsSync(path.join(dir, 'claude-history.jsonl'))) {
    const rounds = parseClaudeHistory(path.join(dir, 'claude-history.jsonl'));
    historySummary = {
      rounds: rounds.length,
      thinkingRounds: rounds.filter((r) => r.thinkingText).length,
      tools: [...new Set(rounds.flatMap((r) => r.toolUses.map((t) => t.name)).filter(Boolean))],
    };
  }
  return { id, path: dir, files, interceptSummary, historySummary };
}

function listClaudeHistories() {
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
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && !seen.has(p)) {
          seen.add(p);
          const stat = fs.statSync(p);
          files.push({
            path: p,
            project: path.basename(path.dirname(p)),
            sessionId: path.basename(p, '.jsonl'),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
    }
  }
  files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return files.slice(0, 20);
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, {
      proxyRunning: Boolean(proxyProcess),
      setupRunning: Boolean(setupProcess),
      certs: {
        certExists: fs.existsSync(path.join(CERT_DIR, 'cert.pem')),
        keyExists: fs.existsSync(path.join(CERT_DIR, 'key.pem')),
        certPath: path.join(CERT_DIR, 'cert.pem'),
        picDir: path.join(PUBLIC_DIR, 'pic'),
      },
      sessions: listSessions(),
      logs: logs.slice(-200),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const body = await parseBody(req);
    return send(res, 200, createSession(body.name));
  }

  if (req.method === 'GET' && url.pathname === '/api/wallpapers') {
    const picDir = path.join(PUBLIC_DIR, 'pic');
    if (!fs.existsSync(picDir)) return send(res, 200, { wallpapers: [] });
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
    const files = fs.readdirSync(picDir)
      .filter((f) => imageExts.includes(path.extname(f).toLowerCase()))
      .map((f) => ({ name: f, path: `/pic/${f}` }));
    return send(res, 200, { wallpapers: files });
  }

  if (req.method === 'POST' && url.pathname === '/api/wallpapers/upload') {
    const picDir = path.join(PUBLIC_DIR, 'pic');
    ensureDir(picDir);
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bufs);
      const ct = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=(.+)/)?.[1];
      if (!boundary) return send(res, 400, { error: 'No boundary' });
      const boundaryBuf = Buffer.from(`--${boundary}`);
      const endBoundary = Buffer.from(`--${boundary}--`);
      // 找第一个 boundary 之后到下一个 boundary 之间的内容
      let start = raw.indexOf(boundaryBuf) + boundaryBuf.length;
      if (raw.slice(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
      const nextBoundary = raw.indexOf(boundaryBuf, start);
      const part = nextBoundary === -1 ? raw.slice(start) : raw.slice(start, nextBoundary);
      // 去掉尾部 \r\n
      let partEnd = part.length;
      while (partEnd > 0 && (part[partEnd - 1] === 0x0d || part[partEnd - 1] === 0x0a)) partEnd--;
      const partData = part.slice(0, partEnd);
      // 找 header 和 body 的分界：\r\n\r\n
      let headerEnd = -1;
      for (let i = 0; i < partData.length - 3; i++) {
        if (partData[i] === 0x0d && partData[i + 1] === 0x0a && partData[i + 2] === 0x0d && partData[i + 3] === 0x0a) {
          headerEnd = i;
          break;
        }
      }
      if (headerEnd === -1) return send(res, 400, { error: 'Bad multipart' });
      const header = partData.slice(0, headerEnd).toString();
      const body = partData.slice(headerEnd + 4);
      // 去掉末尾可能的多余 \r\n
      let bodyEnd = body.length;
      while (bodyEnd > 0 && (body[bodyEnd - 1] === 0x0d || body[bodyEnd - 1] === 0x0a)) bodyEnd--;
      const cleanBody = body.slice(0, bodyEnd);
      const filenameMatch = header.match(/filename="(.+?)"/);
      if (!filenameMatch) return send(res, 400, { error: 'No filename' });
      const fname = filenameMatch[1];
      const dest = path.join(picDir, fname);
      fs.writeFileSync(dest, cleanBody);
      log(`Wallpaper uploaded: ${fname}`);
      return send(res, 200, { ok: true, path: `/pic/${fname}` });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/open-pic-dir') {
    const picDir = path.join(PUBLIC_DIR, 'pic');
    ensureDir(picDir);
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [picDir], { detached: true, stdio: 'ignore' }).unref();
    return send(res, 200, { ok: true, path: picDir });
  }

  if (req.method === 'POST' && url.pathname === '/api/open-dir') {
    const body = await parseBody(req);
    let target = String(body.path || process.cwd()).trim();
    if (!target) target = process.cwd();
    if (!fs.existsSync(target)) target = process.cwd();
    if (!fs.statSync(target).isDirectory()) target = path.dirname(target);
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
    return send(res, 200, { ok: true, path: target });
  }

  if (req.method === 'GET' && url.pathname === '/api/claude-histories') {
    return send(res, 200, { histories: listClaudeHistories() });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?/);
  if (sessionMatch) {
    const id = safeSessionId(sessionMatch[1]);
    const action = sessionMatch[2] || '';
    if (req.method === 'GET' && !action) return send(res, 200, sessionOverview(id));
    if (req.method === 'POST' && action === 'rename') {
      const body = await parseBody(req);
      return send(res, 200, renameSession(id, body.name));
    }
    if (req.method === 'DELETE' && !action) return send(res, 200, deleteSession(id));
    if (req.method === 'POST' && action === 'clear') {
      const dir = sessionDir(id);
      ['https-intercepts.json', 'claude-history.jsonl', 'verification-result.json', 'instance.json', 'trajectory.jsonl', 'delivery.jsonl', 'qc-report.json'].forEach((f) => {
        const fp = path.join(dir, f);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
      log(`Cleared session data: ${id}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'clear-history') {
      const dir = sessionDir(id);
      const fp = path.join(dir, 'claude-history.jsonl');
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      log(`Cleared history file: ${id}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'import') {
      const body = await parseBody(req);
      const dir = sessionDir(id);
      ensureDir(dir);
      if (body.fromSessionId) {
        // 从已有 session 导入
        const fromDir = sessionDir(body.fromSessionId);
        if (!fs.existsSync(fromDir)) throw httpError(404, 'Source session not found');
        const interceptsSrc = path.join(fromDir, 'https-intercepts.json');
        const historySrc = path.join(fromDir, 'claude-history.jsonl');
        if (fs.existsSync(interceptsSrc)) copyIntoSession(interceptsSrc, path.join(dir, 'https-intercepts.json'));
        if (fs.existsSync(historySrc)) copyIntoSession(historySrc, path.join(dir, 'claude-history.jsonl'));
      } else {
        if (body.interceptsPath) copyIntoSession(body.interceptsPath, path.join(dir, 'https-intercepts.json'));
        if (body.historyPath) copyIntoSession(body.historyPath, path.join(dir, 'claude-history.jsonl'));
      }
      log(`Imported files into session ${id}`);
      return send(res, 200, sessionOverview(id));
    }
    const interceptDetailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/intercepts\/(\d+)$/);
    if (req.method === 'GET' && interceptDetailMatch) {
      return send(res, 200, getInterceptDetail(id, interceptDetailMatch[2]));
    }
    if (req.method === 'GET' && action === 'intercepts' && url.pathname.endsWith('/intercepts')) {
      const file = path.join(sessionDir(id), 'https-intercepts.json');
      if (!fs.existsSync(file)) throw httpError(404, 'No intercepts file in session');
      const parsed = parseIntercepts(file);
      return send(res, 200, {
        stats: parsed.stats,
        records: parsed.records.map((r) => ({
          seqIndex: r.seqIndex,
          timestamp: r.timestamp,
          status: r.status,
          path: r.path,
          duration: r.duration,
          requestModel: r.requestModel,
          responseModel: r.responseModel,
          messageCount: r.messageCount,
          hasSystemPrompt: r.hasSystemPrompt,
          toolCalls: r.responseToolCalls.map((t) => t.name),
          reasoningLength: r.responseReasoning.length,
          responsePreview: r.responseContent.slice(0, 240),
          tokens: r.usage,
        })),
      });
    }
    if (req.method === 'POST' && action === 'verify') return send(res, 200, verifySession(id));
    if (req.method === 'POST' && action === 'convert') {
      const body = await parseBody(req);
      return send(res, 200, convertSession(id, body));
    }
    if (req.method === 'GET' && action === 'file') {
      const fileName = url.searchParams.get('name');
      if (!['instance.json', 'trajectory.jsonl', 'delivery.jsonl', 'qc-report.json', 'verification-result.json'].includes(fileName)) {
        throw httpError(400, 'Unsupported file');
      }
      const file = path.join(sessionDir(id), fileName);
      if (!fs.existsSync(file)) throw httpError(404, 'File not found');
      return send(res, 200, fs.readFileSync(file, 'utf8'));
    }
    if (req.method === 'GET' && action === 'download') {
      const fileName = url.searchParams.get('name');
      if (!['instance.json', 'trajectory.jsonl', 'delivery.jsonl', 'qc-report.json', 'verification-result.json'].includes(fileName)) {
        throw httpError(400, 'Unsupported file');
      }
      const file = path.join(sessionDir(id), fileName);
      if (!fs.existsSync(file)) throw httpError(404, 'File not found');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${fileName}"`,
      });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && action === 'open-dir') {
      const dir = assertInsideSessions(sessionDir(id));
      if (!fs.existsSync(dir)) throw httpError(404, 'Session not found');
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true, path: dir });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/certs/setup') {
    if (setupProcess) throw httpError(409, 'Certificate setup is already running');
    setupProcess = spawn(process.execPath, [path.join(ROOT, 'setup-https-proxy.js')], { cwd: ROOT });
    setupProcess.stdout.on('data', (d) => log(String(d).trim()));
    setupProcess.stderr.on('data', (d) => log(String(d).trim()));
    setupProcess.on('exit', (code) => {
      log(`Certificate setup exited with code ${code}`);
      setupProcess = null;
    });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/proxy/start') {
    if (proxyProcess) throw httpError(409, 'Proxy is already running');
    const body = await parseBody(req);
    const id = safeSessionId(body.sessionId);
    const dir = sessionDir(id);
    ensureDir(dir);
    const env = {
      ...process.env,
      PROXY_PORT: String(body.port || 8888),
      TARGET_HOST: body.targetHost || '',
      RESULTS_DIR: dir,
    };
    proxyProcess = spawn(process.execPath, [path.join(ROOT, 'forward-proxy.js')], { cwd: ROOT, env });
    proxyProcess.stdout.on('data', (d) => log(String(d).trim()));
    proxyProcess.stderr.on('data', (d) => log(String(d).trim()));
    proxyProcess.on('exit', (code) => {
      log(`Proxy exited with code ${code}`);
      proxyProcess = null;
      proxySessionId = null;
    });
    proxySessionId = id;
    log(`Proxy started for session ${id} on port ${env.PROXY_PORT}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/proxy/stop') {
    if (!proxyProcess) return send(res, 200, { ok: true, stopped: false });
    proxyProcess.kill('SIGINT');
    return send(res, 200, { ok: true, stopped: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    const stoppedProxy = Boolean(proxyProcess);
    if (proxyProcess) {
      proxyProcess.kill('SIGINT');
      proxyProcess = null;
    }
    if (setupProcess) {
      setupProcess.kill('SIGINT');
      setupProcess = null;
    }
    log('Workbench shutdown requested, exiting…');
    send(res, 200, { ok: true, stoppedProxy });
    setTimeout(() => process.exit(0), 250);
    return;
  }

  throw httpError(404, 'API route not found');
}

// ── Terminal / Shell (node-pty) ─────────────────────────

function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'D:\\Git\\bin\\bash.exe',
    'C:\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveShell(shellCmd) {
  if (!shellCmd) {
    if (process.platform === 'win32') {
      return findGitBash() || 'powershell.exe';
    }
    return process.env.SHELL || 'bash';
  }

  // User-requested shell — resolve shorthand names to full paths on Windows
  if (process.platform === 'win32') {
    if (shellCmd === 'bash') {
      return findGitBash() || 'bash.exe';
    }
    if (shellCmd === 'powershell' || shellCmd === 'pwsh') {
      const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      if (fs.existsSync(pwsh7)) return pwsh7;
      return 'powershell.exe';
    }
    if (shellCmd === 'cmd') return 'cmd.exe';
    // Assume it's already a valid path/executable
    return shellCmd;
  }

  return shellCmd;
}

function spawnPty(shellCmd, cols, rows, cwd, onExit) {
  const cmd = resolveShell(shellCmd || '');
  const env = { ...process.env };
  env.TERM = env.TERM || 'xterm-256color';

  let args = [];

  if (cmd.endsWith('bash.exe') || cmd.endsWith('bash')) {
    // --login reads profile, -i forces interactive on ConPTY
    args = ['--login', '-i'];
  } else if (cmd.endsWith('cmd.exe') || cmd.endsWith('cmd')) {
    args = [];
  } else if (cmd.endsWith('powershell.exe') || cmd.endsWith('powershell') || cmd.endsWith('pwsh.exe') || cmd.endsWith('pwsh')) {
    args = ['-NoLogo'];
  }

  const workDir = (cwd && fs.existsSync(cwd)) ? cwd : process.cwd();
  log(`PTY spawning: ${cmd} ${args.join(' ')} (${cols}x${rows}) cwd=${workDir}`);
  const ptyProc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: workDir,
    env,
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    log(`PTY exited: ${cmd} (code ${exitCode}, signal ${signal})`);
    if (onExit) onExit();
  });

  return ptyProc;
}

ensureDir(SESSIONS_DIR);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || 'Internal error' });
  }
});

// ── WebSocket / Terminal ────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/terminal') {
    const cols = parseInt(url.searchParams.get('cols')) || undefined;
    const rows = parseInt(url.searchParams.get('rows')) || undefined;
    const shell = url.searchParams.get('shell') || '';
    const cwd = url.searchParams.get('cwd') || '';

    wss.handleUpgrade(req, socket, head, (ws) => {
      const ptyProc = spawnPty(shell, cols, rows, cwd, () => {
        // Shell exited — give PTY a tick to flush final output, then close WS
        setTimeout(() => {
          if (ws.readyState === 1) ws.close();
        }, 50);
      });

      log(`Terminal connected: ${shell || getDefaultShell()}`);

      ptyProc.onData((data) => {
        if (ws.readyState === 1) ws.send(data);
      });

      ws.on('message', (raw) => {
        const str = raw.toString();
        // Control messages prefixed with \x00 — never written to the PTY
        if (str.startsWith('\x00')) {
          try {
            const msg = JSON.parse(str.slice(1));
            if (msg.type === 'resize') {
              ptyProc.resize(msg.cols || 80, msg.rows || 24);
            }
          } catch {}
          return;
        }
        try { ptyProc.write(str); } catch {}
      });

      ws.on('close', () => {
        log('Terminal disconnected');
        try { ptyProc.kill(); } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  log(`Workbench running at http://${HOST}:${PORT}`);
});
