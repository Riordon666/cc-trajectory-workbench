/**
 * 正向代理 (Forward Proxy) - MITM 拦截 HTTPS 请求
 *
 * 工作原理：
 *   1. 作为 HTTP 正向代理监听，处理 CONNECT 隧道请求
 *   2. 用自签证书与客户端建立 TLS，再与真实服务器建立 TLS，中间记录明文请求/响应
 *   3. 可通过 TARGET_HOST 环境变量指定仅拦截某个域名，未设置则拦截所有
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseSSE } = require('./workbench/adapters/protocols');

// ── 配置 ──────────────────────────────────────────────
const PROXY_PORT = parseInt(process.env.PROXY_PORT, 10) || 8888;
const PROXY_HOST = '127.0.0.1';
const TARGET_HOST = (process.env.TARGET_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');  // 自动去掉协议前缀和尾部斜杠
const CERT_DIR = path.join(__dirname, 'certs');
const RESULTS_DIR = process.env.RESULTS_DIR
  ? path.resolve(process.env.RESULTS_DIR)
  : path.join(__dirname, 'test-results');

// ── 全局状态 ──────────────────────────────────────────
const INTERCEPTS = [];
let interceptCount = 0;
let activeRequests = 0;
let shuttingDown = false;
const RESULT_FILE = path.join(RESULTS_DIR, 'https-intercepts.json');
const STATUS_FILE = path.join(RESULTS_DIR, 'proxy-status.json');


// ── 证书 ──────────────────────────────────────────────
function loadCerts() {
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const keyFile = path.join(CERT_DIR, 'key.pem');

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.error('❌ 证书不存在，请先运行: node setup-https-proxy.js');
    process.exit(1);
  }

  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
}

// ── MITM：拦截明文 HTTP 请求/响应 ─────────────────────
function handleMITMRequest(clientReq, clientRes, targetHost) {
  const bodyChunks = [];
  clientReq.on('data', (chunk) => bodyChunks.push(chunk));

  clientReq.on('end', () => {
    const requestBody = Buffer.concat(bodyChunks).toString('utf8');
    const startTime = Date.now();
    const targetURL = new URL(clientReq.url, `https://${targetHost}`);
    let requestSettled = false;
    activeRequests++;
    writeStatus();

    console.log(`\n→ [MITM] ${clientReq.method} https://${targetHost}${targetURL.pathname}`);

    const headers = { ...clientReq.headers, host: targetHost };
    delete headers['proxy-connection'];
    // ── 关键修复：删除 content-length，让 fetch/Node.js 自己重新计算 ──
    delete headers['content-length'];

    const proxyReq = https.request(
      {
        hostname: targetHost,
        port: 443,
        path: targetURL.pathname + targetURL.search,
        method: clientReq.method,
        headers,
      },
      (proxyRes) => {
        // 原始字节立即流式转发给客户端；旁路解压只用于采集，不阻塞 Claude Code。
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
        const contentEncoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
        let responseStream = proxyRes;
        if (contentEncoding === 'gzip') {
          responseStream = proxyRes.pipe(zlib.createGunzip());
        } else if (contentEncoding === 'deflate') {
          responseStream = proxyRes.pipe(zlib.createInflate());
        } else if (contentEncoding === 'br') {
          responseStream = proxyRes.pipe(zlib.createBrotliDecompress());
        }

        const responseChunks = [];
        responseStream.on('data', (chunk) => responseChunks.push(chunk));
        let completed = false;
        const finish = (captureComplete, captureError = '') => {
          if (completed || requestSettled) return;
          completed = true;
          requestSettled = true;
          const responseBody = Buffer.concat(responseChunks).toString('utf-8');
          const duration = Date.now() - startTime;

          const isSSE =
            (proxyRes.headers['content-type'] || '').includes('text/event-stream');

          let parsedResponse;
          if (isSSE) {
            const sse = parseSSE(responseBody, {
              agent: 'unknown',
              provider: targetHost.includes('anthropic') ? 'anthropic' : '',
              request_id: `intercept-${interceptCount + 1}`,
            });
            parsedResponse = {
              status: captureComplete ? proxyRes.statusCode : 599,
              upstreamStatus: proxyRes.statusCode,
              headers: redactHeaders(proxyRes.headers),
              streaming: true,
              captureComplete,
              captureError,
              parsed: {
                id: sse.id,
                model: sse.model,
                usage: sse.usage,
                content: sse.content,
                reasoning: sse.reasoning,
                toolCalls: sse.toolCalls,
                chunkCount: sse.chunkCount,
                apiFormat: sse.apiFormat,
                events: sse.events,
              },
            };
          } else {
            parsedResponse = {
              status: captureComplete ? proxyRes.statusCode : 599,
              upstreamStatus: proxyRes.statusCode,
              headers: redactHeaders(proxyRes.headers),
              captureComplete,
              captureError,
              body: tryParse(responseBody),
            };
          }

          const record = {
            id: ++interceptCount,
            timestamp: new Date().toISOString(),
            method: clientReq.method,
            url: `https://${targetHost}${targetURL.pathname}${targetURL.search}`,
            path: targetURL.pathname,
            duration,
            request: {
              headers: redactHeaders(clientReq.headers),
              body: redactCredentials(tryParse(requestBody)),
            },
            response: parsedResponse,
          };

          INTERCEPTS.push(record);
          printSummary(record);
          activeRequests--;
          saveData();
          writeStatus();
        };
        responseStream.on('end', () => finish(true));
        responseStream.on('error', (err) => finish(false, `响应采集失败: ${err.message}`));
        proxyRes.on('aborted', () => finish(false, '上游响应在完成前中断'));
      }
    );

    proxyReq.on('error', (err) => {
      if (requestSettled) return;
      requestSettled = true;
      console.error(`❌ 转发错误: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end('代理错误');
      }
      INTERCEPTS.push({
        id: ++interceptCount,
        timestamp: new Date().toISOString(),
        method: clientReq.method,
        url: `https://${targetHost}${targetURL.pathname}${targetURL.search}`,
        path: targetURL.pathname,
        duration: Date.now() - startTime,
        request: { headers: redactHeaders(clientReq.headers), body: redactCredentials(tryParse(requestBody)) },
        response: { status: 502, headers: {}, captureComplete: false, captureError: err.message, body: '' },
      });
      activeRequests--;
      saveData();
      writeStatus();
    });

    if (requestBody) {
      if (!proxyReq.write(requestBody)) {
        proxyReq.once('drain', () => proxyReq.end());
      } else {
        proxyReq.end();
      }
    } else {
      proxyReq.end();
    }
  });
}

// ── 打印拦截摘要 ──────────────────────────────────────
function printSummary(record) {
  const req = record.request.body;

  console.log(`  ✓ ${record.response.status} (${record.duration}ms)`);

  if (typeof req === 'object' && req !== null) {
    if (req.model) {
      console.log(`  📌 model: ${req.model}`);
      const sysMsg = req.messages?.find((m) => m.role === 'system');
      const hasSystem = !!req.system || !!sysMsg;
      console.log(`  • system: ${hasSystem ? '✓ 存在' : '✗ 不存在'}`);
      console.log(`  • messages: ${req.messages?.length || 0} 条`);
      console.log(`  • max_tokens: ${req.max_tokens || 'N/A'}`);
    }
  }

  if (record.response.streaming && record.response.parsed) {
    const p = record.response.parsed;
    console.log(`  📈 实际模型: ${p.model}`);
    if (p.reasoning) {
      console.log(`  🧠 推理: "${p.reasoning.substring(0, 120)}${p.reasoning.length > 120 ? '...' : ''}"`);
    }
    if (p.content) {
      console.log(`  📝 回复内容: "${p.content.substring(0, 120)}${p.content.length > 120 ? '...' : ''}"`);
    }
    if (p.toolCalls && p.toolCalls.length > 0) {
      console.log(`  🔧 工具调用: ${p.toolCalls.map((tc) => tc.name).join(', ')}`);
    }
    console.log(`  📦 chunks: ${p.chunkCount}`);
    if (p.usage) {
      const u = p.usage;
      const reasoning = u.completion_tokens_details?.reasoning_tokens;
      console.log(`  📊 tokens: ${u.prompt_tokens || u.input_tokens || '?'}in + ${u.completion_tokens || u.output_tokens || '?'}out${reasoning ? ` (reasoning: ${reasoning})` : ''}`);
    }
  } else if (record.response.body && typeof record.response.body === 'object') {
    const res = record.response.body;
    if (res.usage) {
      console.log(`  📈 tokens: ${res.usage.input_tokens}in + ${res.usage.output_tokens}out`);
    }
  }
}

// ── 保存数据 ──────────────────────────────────────────
function saveData() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const temp = `${RESULT_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalInterceptions: INTERCEPTS.length,
    targetHost: TARGET_HOST || '*',
    data: INTERCEPTS,
  }, null, 2));
  fs.renameSync(temp, RESULT_FILE);
  console.log(`💾 已保存 ${INTERCEPTS.length} 条拦截 → ${RESULT_FILE}`);
}

function redactHeaders(headers) {
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key, sensitive.test(key) ? '[REDACTED]' : value]));
}

function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== 'object') return value;
  const sensitive = /^(api[_-]?key|access[_-]?token|auth[_-]?token|authorization)$/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redactCredentials(item)]));
}

function writeStatus() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const temp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    pid: process.pid,
    activeRequests,
    completedInterceptions: INTERCEPTS.length,
    shuttingDown,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(temp, STATUS_FILE);
}

function loadExistingData() {
  if (!fs.existsSync(RESULT_FILE)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    for (const record of existing.data || []) {
      if (record.request) {
        record.request.headers = redactHeaders(record.request.headers);
        record.request.body = redactCredentials(record.request.body);
      }
      if (record.response) record.response.headers = redactHeaders(record.response.headers);
      INTERCEPTS.push(record);
    }
    interceptCount = Math.max(0, ...INTERCEPTS.map((record) => Number(record.id) || 0));
    console.log(`↻ 已载入 ${INTERCEPTS.length} 条已有拦截记录`);
  } catch (err) {
    console.error(`❌ 无法载入已有抓包文件，拒绝覆盖: ${err.message}`);
    process.exit(1);
  }
}

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// ── 主逻辑 ────────────────────────────────────────────
const certs = loadCerts();
loadExistingData();
writeStatus();

const server = http.createServer((req, res) => {
  // 普通 HTTP 请求（非 CONNECT），几乎不会走这里
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Forward proxy is running. Use CONNECT for HTTPS.\n');
});

// 处理 CONNECT 隧道请求
server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port, 10) || 443;

  const shouldIntercept = TARGET_HOST
    ? (hostname === TARGET_HOST || hostname.endsWith(`.${TARGET_HOST}`))
    : true;  // 未配置 TARGET_HOST 时拦截所有请求

  if (shouldIntercept) {
    // ── MITM 模式 ──
    console.log(`🔍 [MITM 拦截] CONNECT ${req.url}`);

    // 告诉客户端隧道已建立
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // 创建 TLS 服务端，与客户端做 TLS 握手
    const tlsServer = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: certs.key,
      cert: certs.cert,
    });

    // 在这个 TLS 连接上解析 HTTP 请求
    const mitmServer = http.createServer((mitmReq, mitmRes) => {
      handleMITMRequest(mitmReq, mitmRes, hostname);
    });

    mitmServer.emit('connection', tlsServer);

    if (head && head.length > 0) {
      tlsServer.unshift(head);
    }
  } else {
    // ── 透传模式：其它域名直接转发 ──
    const targetSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', (err) => {
      console.error(`⚠️  [透传] ${hostname}:${targetPort} 错误: ${err.message}`);
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      targetSocket.end();
    });
  }
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`\n🚀 正向代理运行在 http://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`🎯 MITM 拦截目标: ${TARGET_HOST || '所有 HTTPS 请求'}`);
  if (TARGET_HOST) {
    console.log(`🔀 其它域名: 直接透传`);
  }
  console.log(`\n📋 在另一个终端执行以下命令通过代理启动 Claude Code:`);
  console.log(`  export HTTP_PROXY=http://localhost:${PROXY_PORT}`);
  console.log(`  export HTTPS_PROXY=http://localhost:${PROXY_PORT}`);
  console.log(`  export NODE_EXTRA_CA_CERTS=${path.join(CERT_DIR, 'cert.pem')}`);
  console.log(`  export NODE_TLS_REJECT_UNAUTHORIZED=0`);
  console.log(`  claude --permission-mode bypassPermissions`);
  console.log(`\n⚠️  必须从终端启动，不能从快捷方式打开，否则环境变量不生效`);
  if (TARGET_HOST) {
    console.log(`\n💡 当前仅拦截: ${TARGET_HOST}`);
  } else {
    console.log(`\n💡 未设置 TARGET_HOST，拦截所有请求。如需指定:`);
    console.log(`  TARGET_HOST=your-api-host.com node forward-proxy.js`);
  }
  console.log(`\n等待请求...\n`);
});

// 优雅关闭 — SIGINT (Unix/macOS), SIGTERM (Windows fallback)
function gracefulShutdown(signal) {
  console.log(`\n\n正在关闭... (收到 ${signal})`);
  if (shuttingDown) return;
  shuttingDown = true;
  writeStatus();
  server.close();
  const deadline = Date.now() + 30000;
  const finish = () => {
    if (activeRequests > 0 && Date.now() < deadline) return setTimeout(finish, 100);
    if (INTERCEPTS.length > 0) saveData();
    writeStatus();
    process.exit(activeRequests === 0 ? 0 : 1);
  };
  finish();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('message', (message) => {
  if (message?.type === 'shutdown') gracefulShutdown('IPC');
});
