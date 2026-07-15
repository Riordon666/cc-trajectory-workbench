const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { alignRecords: alignProxyRecords, normalizeText, textComparison, toolComparison } = require('../lib/aligner');
const claudeCode = require('../adapters/agents/claude-code');
const { adapters: protocolAdapters } = require('../adapters/protocols');
const { adapters: agentAdapters, getAgentAdapter } = require('../adapters/agents');
const { appendEvents, eventFingerprint, readEvents, replaceEvents } = require('../core/event-store');
const { diagnoseEvents } = require('../core/diagnostics');
const { buildBundle, importBundle } = require('../core/bundle');
const { hashFile: coreHashFile } = require('../core/hashing');
const { redactCredentials } = require('../core/redaction');
const { createGateway, gatewayInfo } = require('./gateway');
const { attachTerminal } = require('./terminal');

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const SESSIONS_DIR = process.env.WORKBENCH_SESSIONS_DIR ? path.resolve(process.env.WORKBENCH_SESSIONS_DIR) : path.join(ROOT, 'sessions');
const CERT_DIR = process.env.WORKBENCH_CERT_DIR ? path.resolve(process.env.WORKBENCH_CERT_DIR) : path.join(ROOT, 'certs');
const USER_WALLPAPER_DIR = process.env.WORKBENCH_WALLPAPER_DIR ? path.resolve(process.env.WORKBENCH_WALLPAPER_DIR) : path.join(ROOT, 'local-data', 'wallpapers');
const HOST = '127.0.0.1';
const PORT = (() => {
  const portIndex = process.argv.indexOf('--port');
  const portArg = portIndex >= 0 ? process.argv[portIndex + 1] : '';
  const numArg = process.argv.find((a) => /^\d{4,5}$/.test(a));
  return parseInt(portArg || numArg || process.env.WORKBENCH_PORT || '5177', 10);
})();
const MAX_JSON_TEXT_BYTES = 450 * 1024 * 1024;
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;
const WALLPAPER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

function normalizeModelId(value) {
  return String(value || '').trim().toLowerCase();
}

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
  if (!/^[a-zA-Z0-9._-]+$/.test(id || '')) throw httpError(400, '无效的 Session ID');
  return id;
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, safeSessionId(id));
}

function assertInsideSessions(dir) {
  const resolved = path.resolve(dir);
  const root = path.resolve(SESSIONS_DIR);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw httpError(400, '路径超出 Session 目录范围');
  }
  return resolved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readSessionConfig(id) {
  const file = path.join(sessionDir(id), 'config.json');
  return fs.existsSync(file) ? readJson(file) : { id };
}

function writeSessionConfig(id, config) {
  writeJson(path.join(sessionDir(id), 'config.json'), config);
}

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function safeWallpaperFilename(filename) {
  const value = String(filename || '').trim();
  const baseName = path.basename(value);
  const posixBaseName = path.posix.basename(value);
  const winBaseName = path.win32.basename(value);
  if (!value || value !== baseName || value !== posixBaseName || value !== winBaseName) {
    throw httpError(400, '无效的壁纸文件名');
  }
  if (value === '.' || value === '..' || /[<>:"/\\|?*\x00-\x1F]/.test(value)) {
    throw httpError(400, '无效的壁纸文件名');
  }
  const ext = path.extname(value).toLowerCase();
  if (!WALLPAPER_EXTENSIONS.has(ext)) {
    throw httpError(400, '不支持的壁纸文件格式');
  }
  return value;
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
      if (raw.length > 20 * 1024 * 1024) reject(httpError(413, '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, '无效的 JSON 请求体'));
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
  if (!file.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, '文件不存在');
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
        hasHistory: fs.existsSync(path.join(dir, 'agent-history.jsonl')) || fs.existsSync(path.join(dir, 'claude-history.jsonl')),
        hasEvents: fs.existsSync(path.join(dir, 'events.jsonl')),
        hasDiagnostics: fs.existsSync(path.join(dir, 'diagnostics-result.json')),
        agent: config.agent || 'unknown',
        state: config.state || 'draft',
      };
    })
    .sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
}

function renameSession(id, name) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) throw httpError(404, 'Session 不存在');
  const newName = String(name || id).trim();
  if (!newName || newName === id) return { id, config: { id, name: newName } };
  // 重命名目录
  const newDir = path.join(SESSIONS_DIR, newName);
  assertInsideSessions(newDir);
  if (fs.existsSync(newDir)) throw httpError(409, 'Session 名称已存在');
  fs.renameSync(dir, newDir);
  // 更新 config
  const configPath = path.join(newDir, 'config.json');
  const config = fs.existsSync(configPath) ? readJson(configPath) : { id: newName, createdAt: new Date().toISOString() };
  config.id = newName;
  config.name = newName;
  writeJson(configPath, config);
  // 如果正在代理此 session，更新引用
  if (proxySessionId === id) proxySessionId = newName;
  log(`Session 已重命名 ${id} → ${newName}`);
  return { id: newName, config };
}

function deleteSession(id) {
  if (proxySessionId === id && proxyProcess) throw httpError(409, '删除前请先停止代理');
  const dir = assertInsideSessions(sessionDir(id));
  if (!fs.existsSync(dir)) throw httpError(404, 'Session 不存在');
  fs.rmSync(dir, { recursive: true, force: true });
  log(`Session 已删除 ${id}`);
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
    agent: 'unknown',
    captureMode: 'gateway',
  };
  writeJson(path.join(dir, 'config.json'), config);
  log(`Session 已创建 ${id}`);
  return { id, path: dir, config };
}

function copyIntoSession(source, target) {
  if (!source || !fs.existsSync(source)) throw httpError(400, `文件不存在: ${source}`);
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

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  const userMessages = messages.filter((m) => m.role === 'user');
  return userMessages[userMessages.length - 1] || null;
}


function parseIntercepts(filePath) {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize > MAX_JSON_TEXT_BYTES) {
    return {
      raw: {},
      records: [],
      skipped: true,
      skipReason: `https-intercepts.json 文件过大无法安全解析 (${formatBytes(fileSize)}).`,
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
  if (!fs.existsSync(file)) throw httpError(404, 'Session 中没有抓包文件');
  const parsed = parseIntercepts(file);
  const record = parsed.records.find((r) => r.seqIndex === Number(seqIndex));
  if (!record) throw httpError(404, '抓包记录不存在');
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


function alignRecords(proxyRecords, clientRounds) {
  return alignProxyRecords(proxyRecords, clientRounds, makeDetail);
}

function serveUserWallpaper(res, pathname) {
  const name = safeWallpaperFilename(decodeURIComponent(pathname.replace(/^\/user-wallpapers\//, '')));
  const file = path.resolve(USER_WALLPAPER_DIR, name);
  if (!file.startsWith(`${path.resolve(USER_WALLPAPER_DIR)}${path.sep}`) || !fs.existsSync(file)) return send(res, 404, '文件不存在');
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
  res.end(fs.readFileSync(file));
}

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) reject(httpError(413, '请求体过大'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function mainRequestContextFromRecord(record) {
  const body = record?.raw?.request?.body;
  if (!claudeCode.isMainRequest(body)) return null;
  const system = normalizeTrajectoryContent(body.system);
  const tools = normalizeTrajectoryContent(body.tools || []);
  return {
    id: record.id,
    requestModel: body.model || '',
    system,
    tools,
    systemChars: textFromContent(system).length,
    toolsCount: Array.isArray(tools) ? tools.length : 0,
  };
}

function applyRecordingWindow(id, intercepts, rounds) {
  const config = readSessionConfig(id);
  const recording = config.recording || config.capture || {};
  if (!recording.startedAt && !recording.officialStartedAt) return { intercepts, rounds, recording: null, capture: null };
  const startedAt = new Date(recording.startedAt || recording.officialStartedAt).getTime();
  const stoppedAt = (recording.stoppedAt || recording.officialStoppedAt)
    ? new Date(recording.stoppedAt || recording.officialStoppedAt).getTime() : Infinity;
  const startId = Number(recording.startInterceptId || 0);
  const endId = recording.endInterceptId === null || recording.endInterceptId === undefined
    ? Infinity
    : Number(capture.endInterceptId);
  const records = intercepts.records.filter((record) => record.id > startId && record.id <= endId);
  const rawChat = (intercepts.raw?.data || []).filter((entry) => {
    if (!(entry.id > startId && entry.id <= endId)) return false;
    const body = entry.request?.body;
    return entry.method === 'POST'
      && body && typeof body === 'object'
      && (Array.isArray(body.messages) || entry.path?.includes('/messages'))
      && (entry.path?.includes('/chat/completions') || entry.path?.includes('/messages'));
  });
  const filteredRounds = rounds.filter((round) => {
    const timestamp = new Date(round.ts || 0).getTime();
    return Number.isFinite(timestamp) && timestamp >= startedAt && timestamp <= stoppedAt;
  });
  return {
    recording,
    capture: recording,
    rounds: filteredRounds,
    intercepts: {
      ...intercepts,
      records,
      stats: {
        ...intercepts.stats,
        totalChatRequests: rawChat.length,
        failedRequests: rawChat.filter((entry) => entry.response?.status < 200 || entry.response?.status >= 300).length,
        successfulRequests: records.length,
      },
    },
  };
}

const DERIVED_FILES = [
  'diagnostics-result.json',
];

function invalidateDerivedFiles(dir) {
  for (const name of DERIVED_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function diagnosticsIsCurrent(diagnostics, interceptFile, historyFile, recording) {
  if (!diagnostics?.inputFiles) return false;
  return diagnostics.inputFiles.interceptsSha256 === hashFile(interceptFile)
    && diagnostics.inputFiles.historySha256 === hashFile(historyFile)
    && diagnostics.inputFiles.captureSha256 === hashValue(recording);
}

function makeDetail(proxy, client, confidence) {
  const tools = toolComparison(proxy.responseToolCalls, client.toolUses);
  const responseText = textComparison(proxy.responseContent, client.assistantContent);
  const reasoningText = textComparison(proxy.responseReasoning, client.thinkingText);
  const proxyUser = normalizeText(proxy.userContent);
  const clientUser = normalizeText(client.userContent);
  const proxyToolResults = (Array.isArray(proxy.userContentBlocks) ? proxy.userContentBlocks : [])
    .filter((block) => block?.type === 'tool_result')
    .map((block) => ({
      tool_use_id: block.tool_use_id || '',
      content: normalizeText(textFromContent(block.content)),
    }));
  const clientToolResults = (client.toolResults || []).map((result) => ({
    tool_use_id: result.tool_use_id || '',
    content: normalizeText(result.content),
  }));
  const textUserMatch = Boolean(proxyUser && clientUser)
    && (proxyUser === clientUser || proxyUser.includes(clientUser));
  const toolResultUserMatch = clientToolResults.length > 0
    && JSON.stringify(proxyToolResults) === JSON.stringify(clientToolResults);
  const userContentMatch = textUserMatch || toolResultUserMatch;
  const proxyRequestModel = normalizeModelId(proxy.requestModel);
  const proxyResponseModel = normalizeModelId(proxy.responseModel);
  const clientModel = normalizeModelId(client.modelId);
  const responseMatch = responseText.exact
    || (!responseText.comparable && !proxy.responseContent && !client.assistantContent && tools.structureMatch);
  return {
    proxyIndex: proxy.seqIndex,
    clientRound: client.index,
    confidence,
    proxyTime: proxy.timestamp,
    checks: {
      matched: true,
      userContentMatch,
      responseMatch,
      reasoningMatch: reasoningText.exact,
      modelMatch: Boolean(proxyRequestModel && proxyResponseModel && clientModel)
        && proxyRequestModel === proxyResponseModel
        && proxyRequestModel === clientModel,
      proxyModel: proxy.requestModel,
      clientModel: client.modelId,
      actualModel: proxy.responseModel,
      responseToolMatch: tools.structureMatch,
      proxyResponseTools: tools.proxy,
      clientResponseTools: tools.client,
      thinkingInfo: {
        clientHasThinking: Boolean(client.thinkingText),
        clientThinkingLength: client.thinkingText.length,
        proxyHasReasoning: Boolean(proxy.responseReasoning),
        proxyReasoningLength: proxy.responseReasoning.length,
      },
    },
  };
}

function diagnoseSession(id) {
  const dir = sessionDir(id);
  const interceptFile = path.join(dir, 'https-intercepts.json');
  const historyFile = path.join(dir, 'claude-history.jsonl');
  if (!fs.existsSync(interceptFile)) throw httpError(400, 'Session 缺少抓包文件');
  if (!fs.existsSync(historyFile)) throw httpError(400, 'Session 缺少历史文件');

  const windowed = applyRecordingWindow(id, parseIntercepts(interceptFile), claudeCode.parseHistory(historyFile));
  const intercepts = windowed.intercepts;
  const rounds = windowed.rounds;
  const details = alignRecords(intercepts.records, rounds);
  const matched = details.filter((d) => d.checks?.matched).length;
  const rawModelEvidence = [
    ...intercepts.records.flatMap((record) => [record.requestModel, record.responseModel]),
    ...rounds.map((round) => round.modelId),
  ].filter(Boolean);
  const canonicalModels = [...new Set(rawModelEvidence.map(normalizeModelId).filter(Boolean))];
  const unrecognizedModels = [];
  const summary = {
    proxyIntercepts: intercepts.records.length,
    totalRequests: intercepts.stats.totalChatRequests,
    failedRequests: intercepts.stats.failedRequests,
    clientRounds: rounds.length,
    matched,
    responseOk: details.filter((d) => d.checks?.responseMatch).length,
    reasoningOk: details.filter((d) => d.checks?.reasoningMatch).length,
    userOk: details.filter((d) => d.checks?.userContentMatch).length,
    modelOk: details.filter((d) => d.checks?.modelMatch).length,
    toolMatchOk: details.filter((d) => d.checks?.responseToolMatch).length,
    modelEvidence: {
      canonicalModels,
      unrecognizedModels,
      consistentModel: rawModelEvidence.length > 0 && canonicalModels.length === 1,
    },
    thinking: {
      clientThinkingRounds: details.filter((d) => d.checks?.thinkingInfo?.clientHasThinking).length,
      proxyReasoningRounds: details.filter((d) => d.checks?.thinkingInfo?.proxyHasReasoning).length,
      clientSignatureRounds: rounds.filter((round) => Boolean(round.signature)).length,
    },
  };
  summary.coverageOk = matched > 0
    && matched === rounds.length
    && matched === intercepts.records.length;
  summary.allGood = summary.coverageOk
    && summary.failedRequests === 0
    && summary.responseOk === matched
    && summary.reasoningOk === matched
    && summary.userOk === matched
    && summary.modelOk === matched
    && summary.toolMatchOk === matched
    && summary.modelEvidence.consistentModel;

  const warnings = [];
  if (!summary.coverageOk) warnings.push('代理记录与 Agent History 未完全对齐');
  if (summary.failedRequests > 0) warnings.push(`发现 ${summary.failedRequests} 个失败请求`);
  if (summary.reasoningOk < matched) warnings.push('部分 reasoning 不可用或双源内容不一致');
  if (!summary.modelEvidence.consistentModel) warnings.push('观察到多个完整模型标识，请检查是否混入旁路请求');
  const result = {
    timestamp: new Date().toISOString(),
    agent: 'claude-code',
    status: warnings.length ? 'warning' : 'ok',
    nonBlocking: true,
    warnings,
    capture: windowed.capture,
    inputFiles: {
      intercepts: interceptFile,
      history: historyFile,
      interceptsSha256: hashFile(interceptFile),
      historySha256: hashFile(historyFile),
      captureSha256: hashValue(windowed.capture),
    },
    summary,
    details,
  };
  writeJson(path.join(dir, 'diagnostics-result.json'), result);
  return result;
}

function clipReplayText(value, max = 20000) {
  const text = typeof value === 'string' ? value : textFromContent(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n... truncated ${text.length - max} chars`;
}


function replayStatusFromDiagnostics(diagnostics) {
  if (diagnostics.some((d) => d.level === 'error')) return 'error';
  if (diagnostics.some((d) => d.level === 'warn')) return 'warn';
  return 'ok';
}

function addReplayDiagnostic(diagnostics, level, code, message) {
  diagnostics.push({ level, code, message });
}

function diagnoseReplayTurn({ round, proxyRecord, detail }) {
  const diagnostics = [];
  if (!round) {
    addReplayDiagnostic(diagnostics, 'error', 'missing_history_round', '缺少 Claude History 轮次');
  }

  if (!detail) {
    addReplayDiagnostic(diagnostics, 'warn', 'missing_verification', '没有找到这一轮的验证对齐结果');
  } else if (!detail.checks?.matched) {
    addReplayDiagnostic(diagnostics, 'error', 'unmatched_proxy', '代理请求没有匹配到 Claude History 轮次');
  } else {
    const checks = detail.checks || {};
    if (checks.userContentMatch === false) addReplayDiagnostic(diagnostics, 'info', 'user_mismatch', 'User 内容前缀不一致（通常来自 system reminder / 注入上下文差异）');
    if (checks.responseMatch === false) addReplayDiagnostic(diagnostics, 'error', 'response_mismatch', 'Assistant 回复与代理响应不一致');
    if (checks.reasoningMatch === false) addReplayDiagnostic(diagnostics, 'warn', 'reasoning_unavailable_or_mismatch', 'reasoning 不可用或双源内容不一致');
    if (checks.modelMatch === false) addReplayDiagnostic(diagnostics, 'error', 'model_mismatch', '模型字段不一致');
    if (checks.responseToolMatch === false) addReplayDiagnostic(diagnostics, 'error', 'tool_mismatch', 'Tool calls 与 History 记录不一致');
  }

  if (!proxyRecord && detail?.checks?.matched) {
    addReplayDiagnostic(diagnostics, 'error', 'missing_proxy_record', '验证结果引用的代理记录不存在');
  }

  if (proxyRecord?.responseReasoning && !round?.thinkingText) {
    addReplayDiagnostic(diagnostics, 'warn', 'reasoning_not_in_history', '代理侧有 reasoning，但 History 侧没有 thinking');
  }

  if (!diagnostics.length) {
    addReplayDiagnostic(diagnostics, 'info', 'ok', '这一轮验证通过，结构完整');
  }
  return { status: replayStatusFromDiagnostics(diagnostics), diagnostics };
}

function summarizeProxyRecord(record) {
  if (!record) return null;
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
    systemPrompt: clipReplayText(record.systemPrompt, 6000),
    userContent: clipReplayText(record.userContent, 12000),
    responseContent: clipReplayText(record.responseContent, 20000),
    responseReasoning: clipReplayText(record.responseReasoning, 12000),
    responseToolCalls: record.responseToolCalls,
    usage: record.usage,
  };
}

function isReplaySideRequest(record) {
  const userText = String(record?.userContent || '');
  const responseText = String(record?.responseContent || '');
  const patterns = [
    /The user stepped away and is coming back/i,
    /Recap in under \d+ words/i,
    /conversation summary/i,
    /summari[sz]e the conversation/i,
    /generate a concise/i,
  ];
  return patterns.some((pattern) => pattern.test(userText) || pattern.test(responseText));
}

function buildReplayTimeline(id) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) throw httpError(404, 'Session not found');
  if (fs.existsSync(path.join(dir, 'events.jsonl'))) return buildGenericReplayTimeline(id, dir);

  const interceptFile = path.join(dir, 'https-intercepts.json');
  const historyFile = path.join(dir, 'claude-history.jsonl');
  const diagnosticsFile = path.join(dir, 'diagnostics-result.json');

  const parsedIntercepts = fs.existsSync(interceptFile)
    ? parseIntercepts(interceptFile)
    : { records: [], stats: null, skipped: false };
  const parsedRounds = fs.existsSync(historyFile) ? claudeCode.parseHistory(historyFile) : [];
  const windowed = applyRecordingWindow(id, parsedIntercepts, parsedRounds);
  const intercepts = windowed.intercepts;
  const rounds = windowed.rounds;
  const storedVerification = fs.existsSync(diagnosticsFile) ? readJson(diagnosticsFile) : null;
  const verification = storedVerification && diagnosticsIsCurrent(storedVerification, interceptFile, historyFile, windowed.recording)
    ? storedVerification
    : (intercepts.records.length && rounds.length
      ? { timestamp: null, summary: null, details: alignRecords(intercepts.records, rounds) }
      : { timestamp: null, summary: null, details: [] });

  const proxyByIndex = new Map(intercepts.records.map((record) => [record.seqIndex, record]));
  const detailByClientRound = new Map((verification.details || [])
    .filter((detail) => detail.clientRound !== null && detail.clientRound !== undefined)
    .map((detail) => [detail.clientRound, detail]));
  const matchedProxyIndexes = new Set();
  const turns = [];
  const events = [];

  for (const round of rounds) {
    const detail = detailByClientRound.get(round.index) || null;
    const proxyRecord = detail ? proxyByIndex.get(detail.proxyIndex) || null : null;
    if (proxyRecord) matchedProxyIndexes.add(proxyRecord.seqIndex);

    const diagnosis = diagnoseReplayTurn({ round, proxyRecord, detail });
    const turn = {
      turnIndex: round.index,
      status: diagnosis.status,
      diagnostics: diagnosis.diagnostics,
      user: {
        content: clipReplayText(round.userContent, 16000),
        toolResults: (round.toolResults || []).map((toolResult) => ({
          tool_use_id: toolResult.tool_use_id,
          content: clipReplayText(toolResult.content, 12000),
        })),
      },
      assistant: {
        content: clipReplayText(round.assistantContent, 20000),
        thinking: clipReplayText(round.thinkingText, 16000),
        signature: round.signature || '',
        toolUses: round.toolUses || [],
        modelId: round.modelId || '',
        provider: round.provider || '',
        usage: round.usage || null,
        ts: round.ts || null,
        rawUuids: round.rawUuids || [],
      },
      proxy: summarizeProxyRecord(proxyRecord),
      diagnostics: detail,
      verification: detail,
    };
    turns.push(turn);
    events.push({ type: 'user_turn', turnIndex: round.index, status: turn.status, timestamp: round.ts || proxyRecord?.timestamp || null });
    if (proxyRecord) events.push({ type: 'api_request', turnIndex: round.index, proxyIndex: proxyRecord.seqIndex, status: turn.status, timestamp: proxyRecord.timestamp });
    events.push({ type: 'assistant_turn', turnIndex: round.index, status: turn.status, timestamp: round.ts || proxyRecord?.timestamp || null });
    if (detail) events.push({ type: 'verify_check', turnIndex: round.index, proxyIndex: detail.proxyIndex, status: turn.status, confidence: detail.confidence });
  }

  const proxyOnly = intercepts.records
    .filter((record) => !matchedProxyIndexes.has(record.seqIndex))
    .map((record) => {
      const sideRequest = isReplaySideRequest(record);
      return {
        status: 'warn',
        diagnostics: [{
          level: 'warn',
          code: sideRequest ? 'side_request_without_history' : 'extra_proxy_without_history',
          message: sideRequest
            ? '看起来是 Claude Code 自动摘要/旁路请求，不参与 History 轮次匹配'
            : '额外代理请求没有对应的 Claude History 轮次，请确认是否为标题生成、重试或上下文请求',
        }],
        proxy: summarizeProxyRecord(record),
      };
    });

  const problemTurns = turns.filter((turn) => turn.status !== 'ok').length;
  const extraProxyWarnings = proxyOnly.filter((item) => item.status === 'warn').length;
  const proxyOnlyErrors = proxyOnly.filter((item) => item.status === 'error').length;
  return {
    sessionId: id,
    generatedAt: new Date().toISOString(),
    files: {
      intercepts: fs.existsSync(interceptFile),
      history: fs.existsSync(historyFile),
      diagnostics: fs.existsSync(diagnosticsFile),
    },
    stats: intercepts.stats || {},
    verificationSummary: verification.summary || null,
    summary: {
      turns: turns.length,
      proxyRequests: intercepts.records.length,
      matchedTurns: turns.filter((turn) => turn.verification?.checks?.matched).length,
      problemTurns,
      extraProxyWarnings,
      attentionItems: problemTurns + extraProxyWarnings + proxyOnlyErrors,
      okTurns: turns.filter((turn) => turn.status === 'ok').length,
      warnTurns: turns.filter((turn) => turn.status === 'warn').length,
      errorTurns: turns.filter((turn) => turn.status === 'error').length + proxyOnlyErrors,
    },
    turns,
    proxyOnly,
    events,
  };
}


function sessionOverview(id) {
  const dir = sessionDir(id);
  const config = readSessionConfig(id);
  const files = ['config.json', 'events.jsonl', 'gateway-capture.jsonl', 'agent-history.jsonl', 'https-intercepts.json', 'claude-history.jsonl', 'diagnostics-result.json']
    .map((name) => {
      const file = path.join(dir, name);
      return { name, exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
    });
  const interceptFile = path.join(dir, 'https-intercepts.json');
  const historyFile = path.join(dir, 'claude-history.jsonl');
  const genericEvents = readEvents(dir);
  const parsedIntercepts = fs.existsSync(interceptFile)
    ? parseIntercepts(interceptFile)
    : { records: [], stats: null, skipped: false };
  const parsedRounds = fs.existsSync(historyFile) ? claudeCode.parseHistory(historyFile) : [];
  const windowed = applyRecordingWindow(id, parsedIntercepts, parsedRounds);
  const interceptSummary = fs.existsSync(interceptFile) ? windowed.intercepts.stats : null;
  const historySummary = fs.existsSync(historyFile) ? {
    rounds: windowed.rounds.length,
    thinkingRounds: windowed.rounds.filter((round) => round.thinkingText).length,
    signatureRounds: windowed.rounds.filter((round) => round.signature).length,
    tools: [...new Set(windowed.rounds.flatMap((round) => round.toolUses.map((tool) => tool.name)).filter(Boolean))],
  } : null;
  const modelEvidence = [
    ...windowed.intercepts.records.flatMap((record) => [record.requestModel, record.responseModel]),
    ...windowed.rounds.map((round) => round.modelId),
  ].filter(Boolean);
  const models = [...new Set(modelEvidence.map(normalizeModelId).filter(Boolean))];
  let proxyStatus = null;
  const proxyStatusFile = path.join(dir, 'proxy-status.json');
  if (fs.existsSync(proxyStatusFile)) {
    try { proxyStatus = readJson(proxyStatusFile); } catch { proxyStatus = null; }
  }
  const diagnosticsSummary = {
    recordingComplete: Boolean(windowed.recording
      && (windowed.recording.stoppedAt || windowed.recording.officialStoppedAt)),
    proxyRounds: windowed.intercepts.records.length,
    proxyReasoningRounds: windowed.intercepts.records.filter((record) => record.responseReasoning).length,
    clientRounds: windowed.rounds.length,
    clientThinkingRounds: windowed.rounds.filter((round) => round.thinkingText).length,
    clientSignatureRounds: windowed.rounds.filter((round) => round.signature).length,
    failedRequests: windowed.intercepts.stats?.failedRequests || 0,
    activeRequests: Number(proxyStatus?.activeRequests || 0),
    models,
    modelConsistent: modelEvidence.length > 0 && models.length === 1,
    reasoningAvailability: windowed.intercepts.records.length
      ? `${windowed.intercepts.records.filter((record) => record.responseReasoning).length}/${windowed.intercepts.records.length}`
      : 'unavailable',
  };
  return {
    id,
    path: dir,
    files,
    interceptSummary,
    historySummary,
    eventSummary: {
      total: genericEvents.events.length,
      parseErrors: genericEvents.errors.length,
      types: Object.fromEntries([...new Set(genericEvents.events.map((event) => event.event_type))].map((type) => [type, genericEvents.events.filter((event) => event.event_type === type).length])),
      agents: [...new Set(genericEvents.events.map((event) => event.agent).filter(Boolean))],
      providers: [...new Set(genericEvents.events.map((event) => event.provider).filter(Boolean))],
      models: [...new Set(genericEvents.events.map((event) => event.model).filter(Boolean))],
      reasoning: genericEvents.events.some((event) => event.event_type === 'reasoning') ? 'available' : 'unavailable',
      sha256: coreHashFile(path.join(dir, 'events.jsonl')),
    },
    agent: config.agent || 'unknown',
    captureMode: config.captureMode || 'gateway',
    state: config.state || 'draft',
    recording: config.recording || config.capture || null,
    capture: config.recording || config.capture || null,
    connectionCheck: config.connectionCheck || null,
    preflight: config.connectionCheck || null,
    diagnosticsSummary,
    captureEligibility: diagnosticsSummary,
  };
}

function buildGenericReplayTimeline(id, dir) {
  const parsed = readEvents(dir);
  const byRequest = new Map();
  for (const event of parsed.events) {
    const key = event.request_id || `session:${event.timestamp}`;
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key).push(event);
  }
  const turns = [...byRequest.entries()].map(([requestId, events], index) => {
    const diagnostics = [];
    const errors = events.filter((event) => event.event_type === 'error');
    for (const event of errors) diagnostics.push({ level: 'error', code: 'request_error', message: event.content?.message || 'Request error' });
    const hasStart = events.some((event) => event.event_type === 'request_start');
    const hasEnd = events.some((event) => event.event_type === 'request_end');
    if (hasStart && !hasEnd) diagnostics.push({ level: 'warn', code: 'incomplete_request', message: 'Request has no request_end' });
    if (!events.some((event) => event.event_type === 'reasoning')) diagnostics.push({ level: 'info', code: 'reasoning_unavailable', message: 'Reasoning unavailable' });
    const status = replayStatusFromDiagnostics(diagnostics);
    const first = events[0] || {};
    return {
      turnIndex: index, requestId, status, diagnostics,
      user: { content: events.filter((event) => event.event_type === 'user_message').map((event) => event.content?.text || '').filter(Boolean).join('\n'), toolResults: events.filter((event) => event.event_type === 'tool_result').map((event) => event.content) },
      assistant: {
        content: events.filter((event) => event.event_type === 'assistant_message').map((event) => event.content?.text || event.content?.delta || '').join(''),
        thinking: events.filter((event) => event.event_type === 'reasoning').map((event) => event.content?.text || event.content?.delta || '').join('') || 'unavailable',
        toolUses: events.filter((event) => event.event_type === 'tool_call').map((event) => event.content), modelId: first.model || '', provider: first.provider || '',
        usage: events.find((event) => event.event_type === 'usage')?.content || null, ts: first.timestamp || null,
      },
      events, proxy: null, diagnosticsDetail: null, verification: null,
    };
  });
  const diagnostics = diagnoseEvents(parsed.events, parsed.errors);
  return {
    sessionId: id, generatedAt: new Date().toISOString(), files: { events: true, diagnostics: fs.existsSync(path.join(dir, 'diagnostics-result.json')) },
    stats: diagnostics.stats, diagnosticsSummary: diagnostics,
    summary: { turns: turns.length, proxyRequests: diagnostics.stats.requests || 0, matchedTurns: turns.length, problemTurns: turns.filter((turn) => turn.status !== 'ok').length, extraProxyWarnings: 0, attentionItems: diagnostics.counts.warning + diagnostics.counts.error, okTurns: turns.filter((turn) => turn.status === 'ok').length, warnTurns: turns.filter((turn) => turn.status === 'warn').length, errorTurns: turns.filter((turn) => turn.status === 'error').length },
    turns, proxyOnly: [], events: parsed.events,
  };
}

function maxInterceptId(dir) {
  const file = path.join(dir, 'https-intercepts.json');
  if (!fs.existsSync(file)) return 0;
  try {
    return Math.max(0, ...(readJson(file).data || []).map((entry) => Number(entry.id) || 0));
  } catch {
    throw httpError(409, '抓包文件正在写入或无法解析，请稍后重试');
  }
}

function assertProxyIdle(id) {
  const statusFile = path.join(sessionDir(id), 'proxy-status.json');
  if (!fs.existsSync(statusFile)) return;
  let status;
  try {
    status = readJson(statusFile);
  } catch {
    throw httpError(409, '代理状态文件正在写入，请稍后重试');
  }
  if (Number(status.activeRequests) > 0) {
    throw httpError(409, `仍有 ${status.activeRequests} 个模型请求尚未完整结束，请等待 assistant 完整回复后再操作`);
  }
}

function runConnectionCheck(id) {
  const dir = sessionDir(id);
  const config = readSessionConfig(id);
  if ((config.captureMode || 'gateway') === 'gateway') {
    const events = readEvents(dir).events;
    const result = {
      timestamp: new Date().toISOString(), checkedRequestId: events.at(-1)?.request_id || null,
      model: events.findLast?.((event) => event.model)?.model || '', nonBlocking: true,
      checks: { gatewayListening: true, requestObserved: events.some((event) => event.source === 'gateway'), responseObserved: events.some((event) => event.source === 'gateway' && event.event_type === 'request_end') },
    };
    result.passed = result.checks.gatewayListening && result.checks.requestObserved && result.checks.responseObserved;
    config.connectionCheck = result;
    writeSessionConfig(id, config);
    return result;
  }
  const file = path.join(dir, 'https-intercepts.json');
  const parsed = fs.existsSync(file) ? parseIntercepts(file) : { records: [] };
  const record = parsed.records.at(-1) || null;
  const checks = {
    proxyRunning: Boolean(proxyProcess && proxySessionId === id),
    proxyIdle: !fs.existsSync(path.join(dir, 'proxy-status.json'))
      || Number(readJson(path.join(dir, 'proxy-status.json')).activeRequests || 0) === 0,
    requestObserved: Boolean(record),
    responseComplete: Boolean(record && record.raw?.response?.captureComplete !== false),
  };
  const result = {
    timestamp: new Date().toISOString(),
    interceptId: maxInterceptId(dir),
    checkedRequestId: record?.id || null,
    model: record?.responseModel || record?.requestModel || '',
    checks,
    passed: Object.values(checks).every(Boolean),
    nonBlocking: true,
  };
  config.connectionCheck = result;
  writeSessionConfig(id, config);
  return result;
}

function activeRecordingSession(requestedId = '') {
  if (requestedId) {
    try {
      const config = readSessionConfig(safeSessionId(requestedId));
      if (config.state === 'recording') return { id: requestedId, agent: config.agent || 'unknown', dir: sessionDir(requestedId), config };
    } catch {}
  }
  for (const session of listSessions()) {
    if (session.state === 'recording') return { id: session.id, agent: session.agent || 'unknown', dir: sessionDir(session.id), config: readSessionConfig(session.id) };
  }
  return null;
}

function recordGatewayCapture(capture) {
  if (!capture.session || capture.phase === 'response-chunk') return;
  if (capture.events?.length) appendEvents(capture.session.dir, capture.events);
  if (capture.raw) {
    const record = { timestamp: new Date().toISOString(), phase: capture.phase, protocol: capture.protocol, request_id: capture.requestId, event_fingerprints: (capture.events || []).map(eventFingerprint), data: capture.raw };
    fs.appendFileSync(path.join(capture.session.dir, 'gateway-capture.jsonl'), `${JSON.stringify(record)}\n`);
  }
}

function runGenericDiagnostics(id) {
  const dir = sessionDir(id);
  const parsed = readEvents(dir);
  const result = diagnoseEvents(parsed.events, parsed.errors);
  const captureFile = path.join(dir, 'gateway-capture.jsonl');
  if (fs.existsSync(captureFile)) {
    const eventHashes = new Set(parsed.events.map(eventFingerprint));
    const missing = [];
    fs.readFileSync(captureFile, 'utf8').split(/\r?\n/).filter(Boolean).forEach((line) => {
      try { for (const fingerprint of JSON.parse(line).event_fingerprints || []) if (!eventHashes.has(fingerprint)) missing.push(fingerprint); } catch {}
    });
    if (missing.length) {
      result.items.push({ level: 'error', code: 'raw_event_hash_mismatch', message: `${missing.length} captured event fingerprints are missing from events.jsonl` });
      result.counts.error += 1;
      result.status = 'error';
    }
  }
  result.input_hashes = {
    events: coreHashFile(path.join(dir, 'events.jsonl')),
    gateway_capture: coreHashFile(path.join(dir, 'gateway-capture.jsonl')),
    legacy_intercepts: coreHashFile(path.join(dir, 'https-intercepts.json')),
    agent_history: coreHashFile(path.join(dir, 'agent-history.jsonl')) || coreHashFile(path.join(dir, 'claude-history.jsonl')),
  };
  writeJson(path.join(dir, 'diagnostics-result.json'), result);
  return result;
}

function importAgentHistory(id, agentId, source) {
  const adapter = getAgentAdapter(agentId);
  if (!adapter) throw httpError(400, `Unknown Agent adapter: ${agentId}`);
  const resolved = path.resolve(String(source || ''));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw httpError(404, 'Agent History file does not exist');
  const dir = sessionDir(id);
  const parsed = adapter.parseHistory(resolved);
  const events = adapter.historyToEvents(parsed, { session_id: id, source: 'agent-history' });
  copyIntoSession(resolved, path.join(dir, 'agent-history.jsonl'));
  if (agentId === 'claude-code') copyIntoSession(resolved, path.join(dir, 'claude-history.jsonl'));
  const existing = readEvents(dir).events.filter((event) => event.source !== 'agent-history');
  replaceEvents(dir, [...existing, ...events]);
  const config = readSessionConfig(id);
  config.agent = agentId;
  config.history = { adapter: agentId, importedAt: new Date().toISOString(), sourceName: path.basename(resolved), formatVersion: parsed.formatVersion || 'claude-jsonl' };
  writeSessionConfig(id, config);
  invalidateDerivedFiles(dir);
  return { adapter: agentId, events: events.length, formatVersion: config.history.formatVersion };
}

const gatewayHandler = createGateway({
  resolveSession: (req) => activeRecordingSession(String(req.headers['x-agent-trace-session'] || '')),
  onCapture: recordGatewayCapture,
});


async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/adapters') {
    return send(res, 200, {
      agents: agentAdapters.map(({ id, displayName, protocols }) => ({ id, displayName, protocols })),
      protocols: protocolAdapters.map(({ id, displayName }) => ({ id, displayName })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, {
      proxyRunning: Boolean(proxyProcess),
      setupRunning: Boolean(setupProcess),
      certs: {
        certExists: fs.existsSync(path.join(CERT_DIR, 'cert.pem')),
        keyExists: fs.existsSync(path.join(CERT_DIR, 'key.pem')),
        certPath: path.join(CERT_DIR, 'cert.pem'),
        picDir: USER_WALLPAPER_DIR,
      },
      sessions: listSessions(),
      gateway: gatewayInfo(HOST, PORT),
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
    const files = fs.readdirSync(picDir)
      .filter((f) => WALLPAPER_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => ({ name: f, path: `/pic/${f}` }));
    const custom = fs.existsSync(USER_WALLPAPER_DIR) ? fs.readdirSync(USER_WALLPAPER_DIR).filter((f) => WALLPAPER_EXTENSIONS.has(path.extname(f).toLowerCase())).map((f) => ({ name: f, path: `/user-wallpapers/${encodeURIComponent(f)}`, local: true })) : [];
    return send(res, 200, { wallpapers: [...custom, ...files] });
  }

  if (req.method === 'POST' && url.pathname === '/api/wallpapers/upload') {
    const picDir = USER_WALLPAPER_DIR;
    ensureDir(picDir);
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(bufs);
        if (raw.length > MAX_WALLPAPER_BYTES) throw httpError(413, '壁纸文件过大');
        const ct = req.headers['content-type'] || '';
        const boundary = ct.match(/boundary=(.+)/)?.[1];
        if (!boundary) throw httpError(400, '缺少 multipart boundary');
        const boundaryBuf = Buffer.from(`--${boundary}`);
        // 找第一个 boundary 之后到下一个 boundary 之间的内容
        let start = raw.indexOf(boundaryBuf);
        if (start === -1) throw httpError(400, 'multipart 格式错误');
        start += boundaryBuf.length;
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
        if (headerEnd === -1) throw httpError(400, 'multipart 格式错误');
        const header = partData.slice(0, headerEnd).toString();
        const body = partData.slice(headerEnd + 4);
        // 去掉末尾可能的多余 \r\n
        let bodyEnd = body.length;
        while (bodyEnd > 0 && (body[bodyEnd - 1] === 0x0d || body[bodyEnd - 1] === 0x0a)) bodyEnd--;
        const cleanBody = body.slice(0, bodyEnd);
        const filenameMatch = header.match(/filename="(.+?)"/);
        if (!filenameMatch) throw httpError(400, '缺少文件名');
        const fname = safeWallpaperFilename(filenameMatch[1]);
        const picRoot = path.resolve(picDir);
        const dest = path.resolve(picRoot, fname);
        if (!dest.startsWith(`${picRoot}${path.sep}`)) throw httpError(400, '无效的壁纸文件名');
        fs.writeFileSync(dest, cleanBody);
        log(`壁纸已上传: ${fname}`);
        return send(res, 200, { ok: true, path: `/user-wallpapers/${encodeURIComponent(fname)}` });
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || '上传失败' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/open-pic-dir') {
    const picDir = USER_WALLPAPER_DIR;
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

  if (req.method === 'GET' && (url.pathname === '/api/agent-histories' || url.pathname === '/api/claude-histories')) {
    const agent = url.searchParams.get('agent') || 'claude-code';
    const adapter = getAgentAdapter(agent);
    if (!adapter) throw httpError(400, `Agent adapter 不存在: ${agent}`);
    return send(res, 200, { agent, histories: adapter.discoverLocalSessions() });
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
      ['events.jsonl', 'gateway-capture.jsonl', 'agent-history.jsonl', 'https-intercepts.json', 'claude-history.jsonl', 'diagnostics-result.json', 'bundle-manifest.json'].forEach((f) => {
        const fp = path.join(dir, f);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
      log(`Session 数据已清除: ${id}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'clear-history') {
      const dir = sessionDir(id);
      const fp = path.join(dir, 'claude-history.jsonl');
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      const genericHistory = path.join(dir, 'agent-history.jsonl');
      if (fs.existsSync(genericHistory)) fs.unlinkSync(genericHistory);
      invalidateDerivedFiles(dir);
      log(`历史文件已清除: ${id}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (action === 'recording-start' || action === 'capture-start')) {
      const body = await parseBody(req);
      const dir = sessionDir(id);
      const config = readSessionConfig(id);
      if (config.state === 'recording') throw httpError(409, '录制已经开始');
      const captureMode = body.captureMode === 'legacy-mitm' ? 'legacy-mitm' : 'gateway';
      if (captureMode === 'legacy-mitm') {
        if (!proxyProcess || proxySessionId !== id) throw httpError(409, '请先为当前 Session 启动 Advanced/Legacy MITM');
        assertProxyIdle(id);
      }
      invalidateDerivedFiles(dir);
      config.state = 'recording';
      config.captureMode = captureMode;
      config.agent = getAgentAdapter(body.agent)?.id || config.agent || 'unknown';
      config.recording = {
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        startInterceptId: captureMode === 'legacy-mitm' ? maxInterceptId(dir) : 0,
        endInterceptId: null,
      };
      writeSessionConfig(id, config);
      appendEvents(dir, [{ session_id: id, agent: config.agent, provider: 'unknown', model: '', event_type: 'session_start', timestamp: config.recording.startedAt, content: { capture_mode: captureMode }, source: 'workbench' }]);
      log(`录制已开始: ${id}, 起始 intercept #${config.recording.startInterceptId}`);
      return send(res, 200, sessionOverview(id));
    }
    if (req.method === 'POST' && (action === 'recording-stop' || action === 'capture-stop')) {
      const dir = sessionDir(id);
      const config = readSessionConfig(id);
      if (config.state !== 'recording' || !config.recording?.startedAt) throw httpError(409, '当前 Session 未处于录制状态');
      if (config.captureMode === 'legacy-mitm') {
        if (!proxyProcess || proxySessionId !== id) throw httpError(409, '停止 Legacy MITM 录制前代理必须保持运行');
        assertProxyIdle(id);
      }
      config.state = 'recorded';
      config.recording.stoppedAt = new Date().toISOString();
      config.recording.endInterceptId = config.captureMode === 'legacy-mitm' ? maxInterceptId(dir) : null;
      writeSessionConfig(id, config);
      appendEvents(dir, [{ session_id: id, agent: config.agent || 'unknown', provider: 'unknown', model: '', event_type: 'session_end', timestamp: config.recording.stoppedAt, content: { capture_mode: config.captureMode || 'gateway' }, source: 'workbench' }]);
      invalidateDerivedFiles(dir);
      log(`录制已结束: ${id}, 结束 intercept #${config.recording.endInterceptId}`);
      return send(res, 200, sessionOverview(id));
    }
    if (req.method === 'POST' && (action === 'connection-check' || action === 'capture-preflight')) {
      return send(res, 200, runConnectionCheck(id));
    }
    if (req.method === 'POST' && action === 'import') {
      const body = await parseBody(req);
      const dir = sessionDir(id);
      ensureDir(dir);
      if (body.agent && body.historyPath) {
        const imported = importAgentHistory(id, body.agent, body.historyPath);
        log(`Agent History 已导入 Session ${id}: ${body.agent}`);
        return send(res, 200, { ...sessionOverview(id), imported });
      }
      if (body.fromSessionId) {
        // 从已有 session 导入
        const fromDir = sessionDir(body.fromSessionId);
        if (!fs.existsSync(fromDir)) throw httpError(404, '源 Session 不存在');
        invalidateDerivedFiles(dir);
        const interceptsSrc = path.join(fromDir, 'https-intercepts.json');
        const historySrc = path.join(fromDir, 'claude-history.jsonl');
        if (fs.existsSync(interceptsSrc)) copyIntoSession(interceptsSrc, path.join(dir, 'https-intercepts.json'));
        if (fs.existsSync(historySrc)) copyIntoSession(historySrc, path.join(dir, 'claude-history.jsonl'));
        const sourceConfig = readSessionConfig(body.fromSessionId);
        if (sourceConfig.capture?.officialStartedAt) {
          const targetConfig = readSessionConfig(id);
          targetConfig.capture = sourceConfig.capture;
          targetConfig.state = sourceConfig.state || 'captured';
          writeSessionConfig(id, targetConfig);
        }
      } else {
        for (const source of [body.interceptsPath, body.historyPath].filter(Boolean)) {
          if (!fs.existsSync(path.resolve(source))) throw httpError(404, `导入源文件不存在: ${source}`);
        }
        invalidateDerivedFiles(dir);
        if (body.interceptsPath) copyIntoSession(body.interceptsPath, path.join(dir, 'https-intercepts.json'));
        if (body.historyPath) copyIntoSession(body.historyPath, path.join(dir, 'claude-history.jsonl'));
      }
      log(`文件已导入 Session ${id}`);
      return send(res, 200, sessionOverview(id));
    }
    const interceptDetailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/intercepts\/(\d+)$/);
    if (req.method === 'GET' && interceptDetailMatch) {
      return send(res, 200, getInterceptDetail(id, interceptDetailMatch[2]));
    }
    if (req.method === 'GET' && action === 'intercepts' && url.pathname.endsWith('/intercepts')) {
      const file = path.join(sessionDir(id), 'https-intercepts.json');
      if (!fs.existsSync(file)) throw httpError(404, 'Session 中没有抓包文件');
      const parsed = applyRecordingWindow(id, parseIntercepts(file), []).intercepts;
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
    if (req.method === 'GET' && action === 'events') {
      const parsed = readEvents(sessionDir(id));
      const type = url.searchParams.get('type');
      const events = type ? parsed.events.filter((event) => event.event_type === type) : parsed.events;
      return send(res, 200, { events, parseErrors: parsed.errors, reasoning: events.some((event) => event.event_type === 'reasoning') ? 'available' : 'unavailable' });
    }
    if (req.method === 'POST' && (action === 'diagnostics' || action === 'verify')) {
      const eventsFile = path.join(sessionDir(id), 'events.jsonl');
      return send(res, 200, fs.existsSync(eventsFile) ? runGenericDiagnostics(id) : diagnoseSession(id));
    }
    if (req.method === 'GET' && action === 'replay') return send(res, 200, buildReplayTimeline(id));
    if (req.method === 'GET' && action === 'export-events') {
      const parsed = readEvents(sessionDir(id));
      if (!parsed.events.length && !fs.existsSync(path.join(sessionDir(id), 'events.jsonl'))) throw httpError(404, 'Session has no events.jsonl');
      const safe = redactCredentials(parsed.events);
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="${id}-events.jsonl"` });
      return res.end(safe.length ? `${safe.map(JSON.stringify).join('\n')}\n` : '');
    }
    if (req.method === 'GET' && action === 'export-bundle') {
      const dir = sessionDir(id);
      const diagnostics = runGenericDiagnostics(id);
      const bundle = buildBundle(dir, readSessionConfig(id), diagnostics);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${id}-agent-trace.zip"` });
      return res.end(bundle.buffer);
    }
    if (req.method === 'POST' && action === 'import-bundle') {
      const buffer = await readBuffer(req, 512 * 1024 * 1024);
      const imported = importBundle(buffer, sessionDir(id));
      const config = readSessionConfig(id);
      config.agent = imported.manifest.agent_adapter || config.agent || 'unknown';
      config.bundleImportedAt = new Date().toISOString();
      writeSessionConfig(id, config);
      return send(res, 200, { ...sessionOverview(id), imported });
    }
    if (req.method === 'GET' && action === 'file') {
      const fileName = url.searchParams.get('name');
      if (!['diagnostics-result.json'].includes(fileName)) {
        throw httpError(400, '不支持的文件类型');
      }
      const file = path.join(sessionDir(id), fileName);
      if (!fs.existsSync(file)) throw httpError(404, '文件不存在');
      return send(res, 200, fs.readFileSync(file, 'utf8'));
    }
    if (req.method === 'GET' && action === 'download') {
      const fileName = url.searchParams.get('name');
      if (!['diagnostics-result.json'].includes(fileName)) {
        throw httpError(400, '不支持的文件类型');
      }
      const file = path.join(sessionDir(id), fileName);
      if (!fs.existsSync(file)) throw httpError(404, '文件不存在');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${fileName}"`,
      });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && action === 'open-dir') {
      const dir = assertInsideSessions(sessionDir(id));
      if (!fs.existsSync(dir)) throw httpError(404, 'Session 不存在');
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true, path: dir });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/certs/setup') {
    if (setupProcess) throw httpError(409, '证书生成已在运行中');
    setupProcess = spawn(process.execPath, [path.join(ROOT, 'setup-https-proxy.js')], { cwd: ROOT });
    setupProcess.stdout.on('data', (d) => log(String(d).trim()));
    setupProcess.stderr.on('data', (d) => log(String(d).trim()));
    setupProcess.on('exit', (code) => {
      log(`证书生成进程已退出，exit code: ${code}`);
      setupProcess = null;
    });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/proxy/start') {
    if (proxyProcess) throw httpError(409, '代理已在运行中');
    const body = await parseBody(req);
    const id = safeSessionId(body.sessionId);
    const dir = sessionDir(id);
    ensureDir(dir);
    const port = body.port || 8888;

    // 端口可用性预检：bind 一下后立即释放（不指定 host，与 forward-proxy.js 保持一致）
    const portAvailable = await new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
      tester.once('listening', () => { tester.close(); resolve(true); });
      tester.listen(port, HOST);
    });
    if (!portAvailable) throw httpError(409, `端口 ${port} 已被占用`);

    const env = {
      ...process.env,
      PROXY_PORT: String(port),
      TARGET_HOST: body.targetHost || '',
      RESULTS_DIR: dir,
    };
    proxyProcess = spawn(process.execPath, [path.join(ROOT, 'forward-proxy.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    proxyProcess.stdout.on('data', (d) => log(String(d).trim()));
    proxyProcess.stderr.on('data', (d) => log(String(d).trim()));

    // 秒挂检测：代理进程启动后很短时间内退出则记一条错误日志
    const quickExitTimer = setTimeout(() => {
      if (proxyProcess === null) {
        log('⚠️  代理启动后立刻退出，请检查上方日志排查原因');
      }
    }, 3000);

    proxyProcess.on('exit', (code) => {
      clearTimeout(quickExitTimer);
      log(`代理已退出，exit code: ${code}`);
      proxyProcess = null;
      proxySessionId = null;
    });

    proxySessionId = id;
    log(`代理已启动，Session: ${id}，端口: ${port}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/proxy/stop') {
    if (!proxyProcess) return send(res, 200, { ok: true, stopped: false });
    const p = proxyProcess;
    const pid = p.pid;
    log(`正在停止代理 (pid ${pid})...`);

    // 通过 IPC 请求优雅关闭，等待正在流式返回的最后一轮完整落盘。
    if (p.connected) p.send({ type: 'shutdown' });
    else p.kill('SIGTERM');

    // 等待进程真正退出；Windows 上 SIGINT 不会生效，超时后走 SIGTERM → taskkill
    const exited = await new Promise((resolve) => {
      const onExit = () => resolve(true);
      p.on('exit', onExit);

      // 32s 后才升级为 SIGTERM；代理自身最多等待在途请求 30s。
      const sigtermTimer = setTimeout(() => {
        if (p.exitCode !== null) return;
        log('SIGINT 未能停止代理，尝试 SIGTERM...');
        try { p.kill('SIGTERM'); } catch {}
      }, 32000);

      // 35s 后若仍未退出，最后才强制终止。
      const forceTimer = setTimeout(() => {
        if (p.exitCode !== null) return;
        log('SIGTERM 未能停止代理，Windows 上强制终止...');
        try {
          if (process.platform === 'win32') {
            require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } else {
            p.kill('SIGKILL');
          }
        } catch {}
        // taskkill 成功会触发 exit 事件；若仍没有，手动 resolve
        setTimeout(() => { if (p.exitCode === null) resolve(false); }, 400);
      }, 35000);

      p.on('exit', () => {
        clearTimeout(sigtermTimer);
        clearTimeout(forceTimer);
        onExit();
      });
    });

    log(exited ? `代理已停止 (pid ${pid})` : `代理进程 ${pid} 已被强制终止`);
    return send(res, 200, { ok: true, stopped: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    const stoppedProxy = Boolean(proxyProcess);
    if (proxyProcess) {
      const p = proxyProcess;
      proxyProcess = null;
      if (p.connected) p.send({ type: 'shutdown' });
      else p.kill('SIGTERM');
      setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 32000);
      p.once('exit', () => setTimeout(() => process.exit(0), 100));
    }
    if (setupProcess) {
      const s = setupProcess;
      setupProcess = null;
      s.kill('SIGINT');
      setTimeout(() => { try { s.kill('SIGTERM'); } catch {} }, 1000);
    }
    log('收到关闭工作台请求，正在退出…');
    send(res, 200, { ok: true, stoppedProxy });
    if (!stoppedProxy) setTimeout(() => process.exit(0), 250);
    else setTimeout(() => process.exit(1), 35000);
    return;
  }

  throw httpError(404, 'API 路由不存在');
}


ensureDir(SESSIONS_DIR);

const server = http.createServer(async (req, res) => {
  const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 403, { error: 'Host not allowed' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/gateway/')) {
      const handled = await gatewayHandler(req, res, url);
      if (handled) return;
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/user-wallpapers/')) return serveUserWallpaper(res, url.pathname);
    return serveStatic(res, url.pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || '内部错误' });
  }
});

attachTerminal(server, { host: HOST, port: PORT, rootDir: ROOT, log });


server.listen(PORT, HOST, () => {
  log(`工作台已启动 http://${HOST}:${PORT}`);
});
