const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { createEvent } = require('../core/event-schema');
const { parseJSON, parseSSE } = require('../adapters/protocols');
const { redactHeaders, redactCredentials } = require('../core/redaction');

const ROUTES = {
  '/gateway/anthropic/v1/messages': { protocol: 'anthropic-messages', env: 'ANTHROPIC_UPSTREAM_BASE_URL', fallback: 'https://api.anthropic.com', upstreamPath: '/v1/messages' },
  '/gateway/openai/v1/responses': { protocol: 'openai-responses', env: 'OPENAI_UPSTREAM_BASE_URL', fallback: 'https://api.openai.com', upstreamPath: '/v1/responses' },
};

function gatewayInfo(host, port) {
  return {
    mode: 'gateway',
    listen: `http://${host}:${port}`,
    endpoints: Object.entries(ROUTES).map(([path, route]) => ({ protocol: route.protocol, base_url: `http://${host}:${port}${path.replace(/\/v1\/(messages|responses)$/, '')}`, endpoint: path })),
  };
}

function createGateway({ resolveSession, onCapture, timeoutMs = 120000 } = {}) {
  return async function handleGateway(req, res, url) {
    const route = ROUTES[url.pathname];
    if (!route || req.method !== 'POST') return false;
    const session = resolveSession?.(req) || null;
    const requestId = String(req.headers['x-request-id'] || req.headers['x-agent-trace-request'] || crypto.randomUUID());
    const rawBody = await readBody(req, 32 * 1024 * 1024);
    let requestBody;
    try { requestBody = JSON.parse(rawBody || '{}'); } catch { return jsonError(res, 400, 'Gateway request body must be JSON'); }
    const upstream = resolveUpstream(route);
    const context = {
      session_id: session?.id || String(req.headers['x-agent-trace-session'] || ''),
      request_id: requestId,
      agent: String(req.headers['x-agent-trace-agent'] || session?.agent || 'unknown'),
      provider: route.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
      model: String(requestBody.model || ''),
      source: 'gateway',
    };
    const requestEvents = requestToEvents(route.protocol, requestBody, context);
    onCapture?.({ phase: 'request', session, protocol: route.protocol, requestId, raw: { headers: redactHeaders(req.headers), body: redactCredentials(requestBody) }, events: requestEvents });

    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: upstream.host, 'content-length': Buffer.byteLength(rawBody) };
    delete headers['x-agent-trace-session'];
    delete headers['x-agent-trace-agent'];
    delete headers['x-agent-trace-request'];
    delete headers['proxy-connection'];
    let clientClosed = false;
    let upstreamReq;
    req.on('aborted', () => { clientClosed = true; });
    res.on('close', () => { if (!res.writableEnded) { clientClosed = true; upstreamReq?.destroy(new Error('Client disconnected')); } });

    await new Promise((resolve) => {
      upstreamReq = transport.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: 'POST', path: route.upstreamPath, headers, timeout: timeoutMs }, (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        const chunks = [];
        upstreamRes.on('data', (chunk) => {
          chunks.push(chunk);
          if (!clientClosed && !res.destroyed) res.write(chunk);
          onCapture?.({ phase: 'response-chunk', session, protocol: route.protocol, requestId, bytes: chunk.length });
        });
        upstreamRes.on('end', () => {
          if (!clientClosed && !res.destroyed) res.end();
          const body = decodeBody(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8');
          const streaming = String(upstreamRes.headers['content-type'] || '').includes('text/event-stream');
          let parsed;
          try { parsed = streaming ? parseSSE(body, context) : parseJSON(route.protocol, body, context); }
          catch (error) { parsed = { events: [createEvent({ ...context, event_type: 'error', content: { message: `Response parse failed: ${error.message}` } })] }; }
          const events = (parsed.events || []).filter((event) => event.event_type !== 'request_start');
          if ((upstreamRes.statusCode || 500) >= 400) events.push(createEvent({ ...context, event_type: 'error', content: { message: `Upstream HTTP ${upstreamRes.statusCode}`, status: upstreamRes.statusCode } }));
          if (clientClosed) events.push(createEvent({ ...context, event_type: 'error', content: { message: 'Client disconnected', cancelled: true } }));
          onCapture?.({ phase: 'response', session, protocol: route.protocol, requestId, raw: { status: upstreamRes.statusCode, headers: redactHeaders(upstreamRes.headers), streaming, complete: true, body: redactCredentials(streaming ? { sse: body } : safeJson(body)) }, events });
          resolve();
        });
        upstreamRes.on('aborted', () => {
          const events = [
            createEvent({ ...context, event_type: 'error', content: { message: 'Upstream response aborted', partial: true } }),
            createEvent({ ...context, event_type: 'request_end', content: { complete: false } }),
          ];
          onCapture?.({ phase: 'response', session, protocol: route.protocol, requestId, raw: { status: upstreamRes.statusCode, complete: false }, events });
          if (!res.destroyed) res.end();
          resolve();
        });
      });
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('Upstream timeout')));
      upstreamReq.on('error', (error) => {
        if (!res.headersSent) jsonError(res, 502, 'Gateway upstream request failed');
        else if (!res.destroyed) res.end();
        onCapture?.({ phase: 'error', session, protocol: route.protocol, requestId, events: [
          createEvent({ ...context, event_type: 'error', content: { message: error.message, cancelled: clientClosed } }),
          createEvent({ ...context, event_type: 'request_end', content: { complete: false } }),
        ] });
        resolve();
      });
      upstreamReq.end(rawBody);
    });
    return true;
  };
}

function resolveUpstream(route) {
  const raw = process.env[route.env] || route.fallback;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error(`${route.env} must be an http(s) origin without credentials, path or fragment`);
  }
  if (isBlockedHostname(url.hostname) && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error(`${route.env} resolves to a disallowed local/network target`);
  return url;
}

function isBlockedHostname(hostname) {
  return /^(0\.0\.0\.0|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

function requestToEvents(protocol, body, context) {
  const events = [createEvent({ ...context, event_type: 'request_start', content: { protocol, streaming: Boolean(body.stream) } })];
  const messages = protocol === 'anthropic-messages' ? body.messages : normalizeOpenAIInput(body.input);
  for (const message of messages || []) {
    if (message.role !== 'user') continue;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content || '') }];
    const text = blocks.map((block) => block.text || block.input_text || '').filter(Boolean).join('\n');
    if (text) events.push(createEvent({ ...context, event_type: 'user_message', content: { text } }));
    for (const block of blocks) if (block.type === 'tool_result' || block.type === 'function_call_output') events.push(createEvent({ ...context, event_type: 'tool_result', content: block }));
  }
  return events;
}

function normalizeOpenAIInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  return Array.isArray(input) ? input : [];
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > limit) reject(new Error('Gateway body too large')); else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJson(value) { try { return JSON.parse(value); } catch { return { text: value }; } }
function decodeBody(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {}
  return buffer;
}
function jsonError(res, status, message) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })); return true; }

module.exports = { ROUTES, createGateway, decodeBody, gatewayInfo, isBlockedHostname, requestToEvents, resolveUpstream };
