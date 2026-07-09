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

// ── 配置 ──────────────────────────────────────────────
const PROXY_PORT = parseInt(process.env.PROXY_PORT, 10) || 8888;
const TARGET_HOST = (process.env.TARGET_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');  // 自动去掉协议前缀和尾部斜杠
const CERT_DIR = path.join(__dirname, 'certs');
const RESULTS_DIR = process.env.RESULTS_DIR
  ? path.resolve(process.env.RESULTS_DIR)
  : path.join(__dirname, 'test-results');

// ── 全局状态 ──────────────────────────────────────────
const INTERCEPTS = [];
let interceptCount = 0;

// ── SSE 流解析 ────────────────────────────────────────
function parseSSEResponse(raw) {
  const lines = raw.split('\n');
  const chunks = [];
  let fullContent = '';
  let reasoningContent = '';
  let model = '';
  let id = '';
  let usage = null;
  let apiFormat = 'unknown'; // 'openai' or 'anthropic'
  const toolCalls = {}; // index -> {name, arguments}

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;

    try {
      const obj = JSON.parse(payload);
      chunks.push(obj);

      // ── 检测并处理 Anthropic Messages API 格式 ────────
      // Anthropic SSE 事件有 type 字段: message_start, content_block_start,
      // content_block_delta, content_block_stop, message_delta, message_stop
      if (obj.type) {
        apiFormat = 'anthropic';

        if (obj.type === 'message_start' && obj.message) {
          model = obj.message.model || '';
          id = obj.message.id || '';
          if (obj.message.usage) usage = obj.message.usage;
        }

        if (obj.type === 'content_block_start' && obj.content_block) {
          const block = obj.content_block;
          if (block.type === 'tool_use') {
            const idx = obj.index ?? Object.keys(toolCalls).length;
            toolCalls[idx] = { id: block.id || '', name: block.name || '', arguments: '' };
          }
        }

        if (obj.type === 'content_block_delta' && obj.delta) {
          const delta = obj.delta;
          if (delta.type === 'text_delta' && delta.text) {
            fullContent += delta.text;
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            reasoningContent += delta.thinking;
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            // tool_use 参数的增量
            const idx = obj.index ?? 0;
            if (toolCalls[idx]) toolCalls[idx].arguments += delta.partial_json;
          }
        }

        if (obj.type === 'message_delta') {
          if (obj.usage) {
            // 合并 usage（Anthropic 分开发送 input/output usage）
            usage = usage ? { ...usage, ...obj.usage } : obj.usage;
          }
        }

        continue;
      }

      // ── OpenAI / OpenRouter 格式 ─────────────────────
      apiFormat = 'openai';
      if (obj.model) model = obj.model;
      if (obj.id) id = obj.id;
      if (obj.usage) usage = obj.usage;

      if (obj.choices) {
        for (const choice of obj.choices) {
          const delta = choice.delta;
          if (!delta) continue;
          if (delta.content) fullContent += delta.content;
          // 捕获 reasoning / thinking 内容
          if (delta.reasoning) reasoningContent += delta.reasoning;
          if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
          // 捕获 tool_calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch {
      // 非 JSON 行，跳过
    }
  }

  return {
    id,
    model,
    usage,
    content: fullContent,
    reasoning: reasoningContent,
    toolCalls: Object.values(toolCalls),
    chunkCount: chunks.length,
    apiFormat,
  };
}

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
        // 解压缩响应（gzip/deflate/br）
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

        responseStream.on('end', () => {
          const responseBody = Buffer.concat(responseChunks).toString('utf-8');
          const duration = Date.now() - startTime;
          interceptCount++;

          const isSSE =
            (proxyRes.headers['content-type'] || '').includes('text/event-stream');

          let parsedResponse;
          if (isSSE) {
            const sse = parseSSEResponse(responseBody);
            parsedResponse = {
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              streaming: true,
              parsed: {
                id: sse.id,
                model: sse.model,
                usage: sse.usage,
                content: sse.content,
                reasoning: sse.reasoning,
                toolCalls: sse.toolCalls,
                chunkCount: sse.chunkCount,
              },
            };
          } else {
            parsedResponse = {
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: tryParse(responseBody),
            };
          }

          const record = {
            id: interceptCount,
            timestamp: new Date().toISOString(),
            method: clientReq.method,
            url: `https://${targetHost}${targetURL.pathname}${targetURL.search}`,
            path: targetURL.pathname,
            duration,
            request: {
              headers: clientReq.headers,
              body: tryParse(requestBody),
            },
            response: parsedResponse,
          };

          INTERCEPTS.push(record);
          printSummary(record);

          // 转发给客户端（发送解压后的数据，去掉 content-encoding）
          const fwdHeaders = { ...proxyRes.headers };
          if (contentEncoding) {
            delete fwdHeaders['content-encoding'];
            delete fwdHeaders['content-length'];
            fwdHeaders['transfer-encoding'] = 'chunked';
          }
          clientRes.writeHead(proxyRes.statusCode, fwdHeaders);
          clientRes.end(responseBody);
        });
      }
    );

    proxyReq.on('error', (err) => {
      console.error(`❌ 转发错误: ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end('代理错误');
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

  const filepath = path.join(RESULTS_DIR, 'https-intercepts.json');
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        totalInterceptions: INTERCEPTS.length,
        targetHost: TARGET_HOST || '*',
        data: INTERCEPTS,
      },
      null,
      2
    )
  );
  console.log(`💾 已保存 ${INTERCEPTS.length} 条拦截 → ${filepath}`);
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

server.listen(PROXY_PORT, () => {
  console.log(`\n🚀 正向代理运行在 http://localhost:${PROXY_PORT}`);
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

// 定期保存
setInterval(() => {
  if (INTERCEPTS.length > 0) saveData();
}, 3000);

// 优雅关闭 — SIGINT (Unix/macOS), SIGTERM (Windows fallback)
function gracefulShutdown(signal) {
  console.log(`\n\n正在关闭... (收到 ${signal})`);
  if (INTERCEPTS.length > 0) saveData();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
