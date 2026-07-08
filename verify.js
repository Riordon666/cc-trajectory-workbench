/**
 * 验证工具：对比代理拦截数据 vs Cline/Claude Code 本地历史
 *
 * 用法：
 *   node verify.js                  # 自动检测客户端并找最新历史
 *   node verify.js <task_id>        # 指定 Cline task ID
 *   node verify.js --claude <session_id>  # 指定 Claude Code session ID
 */

const fs = require('fs');
const path = require('path');

// ── 配置 ──────────────────────────────────────────────
const INTERCEPT_FILE = path.join(__dirname, 'test-results/https-intercepts.json');
const CLINE_TASKS_DIR = path.join(process.env.HOME, '.cline/data/tasks');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude/projects');

// ── 检测客户端类型（基于拦截数据的 API 格式）───────────
function detectClient(interceptFile) {
  const raw = JSON.parse(fs.readFileSync(interceptFile, 'utf-8'));
  for (const d of raw.data) {
    if (d.method !== 'POST') continue;
    const body = d.request.body;
    if (typeof body !== 'object' || body === null) continue;
    // Anthropic 原生格式有 system 作为独立字段且无 messages[0].role=system
    if ('system' in body && body.max_tokens && !body.stream_options) {
      return 'claude';
    }
    // OpenAI/OpenRouter 格式
    if (body.messages && body.stream_options) {
      return 'cline';
    }
    // Fallback: check include_reasoning (OpenRouter via Cline)
    if (body.include_reasoning) return 'cline';
    if (body.thinking) return 'claude';
  }
  return 'cline'; // 默认
}

// ── 找到 Cline 历史 ──────────────────────────────────
function findClineHistory(taskId) {
  if (taskId) {
    const p = path.join(CLINE_TASKS_DIR, taskId, 'api_conversation_history.json');
    if (!fs.existsSync(p)) {
      console.error(`❌ 找不到 Cline task ${taskId}`);
      process.exit(1);
    }
    return p;
  }

  if (!fs.existsSync(CLINE_TASKS_DIR)) {
    console.error('❌ 找不到 Cline 数据目录');
    process.exit(1);
  }

  const tasks = fs.readdirSync(CLINE_TASKS_DIR)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(b) - Number(a));

  for (const t of tasks) {
    const p = path.join(CLINE_TASKS_DIR, t, 'api_conversation_history.json');
    if (fs.existsSync(p)) return p;
  }

  console.error('❌ 找不到任何 Cline 历史记录');
  process.exit(1);
}

// ── 找到 Claude Code 历史 ─────────────────────────────
function findClaudeHistory(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    console.error('❌ 找不到 Claude Code 数据目录');
    process.exit(1);
  }

  // 遍历所有 project 目录找 session 文件
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  const candidates = [];

  for (const dir of projectDirs) {
    const projectPath = path.join(CLAUDE_PROJECTS_DIR, dir);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      const fp = path.join(projectPath, f);
      const sid = f.replace('.jsonl', '');
      if (sessionId && sid !== sessionId) continue;
      const stat = fs.statSync(fp);
      candidates.push({ path: fp, sessionId: sid, mtime: stat.mtimeMs });
    }
  }

  if (sessionId && candidates.length === 0) {
    console.error(`❌ 找不到 Claude Code session ${sessionId}`);
    process.exit(1);
  }

  if (candidates.length === 0) {
    console.error('❌ 找不到任何 Claude Code 历史记录');
    process.exit(1);
  }

  // 按修改时间排序，取最新的
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

// ── 提取 Cline 记录的关键数据 ─────────────────────────
function parseClineHistory(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const rounds = [];

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];
    if (msg.role !== 'assistant') continue;

    // 前一条应该是 user
    const userMsg = i > 0 && raw[i - 1].role === 'user' ? raw[i - 1] : null;

    // 提取 user 消息的文本内容
    let userText = '';
    if (userMsg) {
      if (typeof userMsg.content === 'string') {
        userText = userMsg.content;
      } else if (Array.isArray(userMsg.content)) {
        userText = userMsg.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
      }
    }

    // 提取 assistant 回复 — 只取 text 块
    let assistantText = '';
    const thinkingBlocks = [];
    const toolUseBlocks = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          assistantText += (assistantText ? '\n' : '') + block.text;
        } else if (block.type === 'thinking') {
          thinkingBlocks.push(block.thinking || block.text || '');
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({ name: block.name, input: block.input });
        }
      }
    } else if (typeof msg.content === 'string') {
      assistantText = msg.content;
    }

    rounds.push({
      index: rounds.length,
      rawIndex: i,
      userContent: userText,
      assistantContent: assistantText,
      thinkingText: thinkingBlocks.join('\n'),
      toolUses: toolUseBlocks,
      modelId: msg.modelInfo?.modelId,
      providerId: msg.modelInfo?.providerId,
      metrics: msg.metrics,
      ts: msg.ts,
    });
  }

  return rounds;
}

// ── 提取 Claude Code 记录的关键数据 ──────────────────
function parseClaudeHistory(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
  const entries = lines.map((l) => JSON.parse(l));

  // Claude Code JSONL 格式：每条是独立的 type=user/assistant/tool_result/system/progress 等
  // assistant 的 content 被拆成多条记录（text, thinking, tool_use 各一条）
  // 需要合并连续的 assistant 记录为一个 "turn"
  const rounds = [];
  let currentUser = null;
  let currentAssistant = { text: '', thinking: '', toolUses: [] };
  let inAssistant = false;

  for (const entry of entries) {
    if (entry.type === 'user') {
      // 如果之前在收集 assistant，先保存
      if (inAssistant) {
        rounds.push({
          index: rounds.length,
          userContent: currentUser || '',
          assistantContent: currentAssistant.text,
          thinkingText: currentAssistant.thinking,
          toolUses: currentAssistant.toolUses,
          modelId: null,
          metrics: null,
          ts: null,
        });
        currentAssistant = { text: '', thinking: '', toolUses: [] };
        inAssistant = false;
      }

      // 提取 user 消息内容
      const msg = entry.message;
      if (typeof msg.content === 'string') {
        currentUser = msg.content;
      } else if (Array.isArray(msg.content)) {
        // tool_result 类型的 user 消息
        const texts = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text);
        const toolResults = msg.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => `[tool_result ${b.tool_use_id}]`);
        currentUser = [...texts, ...toolResults].join('\n') || currentUser;
      }
    } else if (entry.type === 'assistant') {
      inAssistant = true;
      const msg = entry.message;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            currentAssistant.text += (currentAssistant.text ? '\n' : '') + block.text;
          } else if (block.type === 'thinking') {
            currentAssistant.thinking += (currentAssistant.thinking ? '\n' : '') + (block.thinking || block.text || '');
          } else if (block.type === 'tool_use') {
            currentAssistant.toolUses.push({ name: block.name, input: block.input });
          }
          // redacted_thinking 跳过（无法查看）
        }
      }
    }
  }

  // 保存最后一个 assistant turn
  if (inAssistant) {
    rounds.push({
      index: rounds.length,
      userContent: currentUser || '',
      assistantContent: currentAssistant.text,
      thinkingText: currentAssistant.thinking,
      toolUses: currentAssistant.toolUses,
      modelId: null,
      metrics: null,
      ts: null,
    });
  }

  return rounds;
}

// ── 规范化 usage 字段（兼容 OpenAI 和 Anthropic 格式）──
function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    ...usage,
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

// ── 提取代理拦截的关键数据 ─────────────────────────────
function parseIntercepts(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // 只保留 POST 对话请求（跳过 GET /models 等）
  // OpenAI/OpenRouter: /chat/completions, Anthropic: /v1/messages
  const allChatRequests = raw.data.filter((d) =>
    d.method === 'POST'
    && (d.path.includes('/chat/completions') || d.path.includes('/messages'))
    && typeof d.request.body === 'object' && d.request.body !== null
    && d.request.body.messages
  );

  // 分离成功/失败请求，仅保留 2xx 用于对比
  const failed = allChatRequests.filter((d) => d.response.status < 200 || d.response.status >= 300);
  const chatRequests = allChatRequests.filter((d) => d.response.status >= 200 && d.response.status < 300);

  if (failed.length > 0) {
    const byModel = {};
    for (const d of failed) {
      const m = d.request.body.model || 'unknown';
      if (!byModel[m]) byModel[m] = { count: 0, status: d.response.status };
      byModel[m].count++;
    }
    console.log(`⚠️  过滤掉 ${failed.length} 条失败请求 (非 2xx):`);
    for (const [model, info] of Object.entries(byModel)) {
      console.log(`   • ${model}: ${info.count} 条 (HTTP ${info.status})`);
    }
  }

  const records = chatRequests.map((d, idx) => {
    const req = d.request.body;

    // 提取请求中最后一条 user 消息内容
    let userContent = '';
    if (req.messages) {
      const userMsgs = req.messages.filter((m) => m.role === 'user');
      const lastUser = userMsgs[userMsgs.length - 1];
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          userContent = lastUser.content;
        } else if (Array.isArray(lastUser.content)) {
          userContent = lastUser.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
        }
      }
    }

    // 提取请求中是否包含 system prompt
    // Anthropic: req.system 独立字段; OpenAI: messages[0].role='system'
    let hasSystemPrompt = false;
    if (req.system) {
      hasSystemPrompt = true;
    } else if (req.messages?.some((m) => m.role === 'system')) {
      hasSystemPrompt = true;
    }

    // 提取请求中历史 assistant 消息的推理内容
    // OpenRouter: reasoning_details[].type='reasoning.text'
    // Anthropic: content[].type='thinking'
    const reqReasoningTexts = [];
    if (req.messages) {
      for (const m of req.messages) {
        if (m.role !== 'assistant') continue;
        // OpenRouter 格式
        if (m.reasoning_details) {
          for (const rd of m.reasoning_details) {
            if (rd.type === 'reasoning.text' && rd.text) {
              reqReasoningTexts.push(rd.text);
            }
          }
        }
        // Anthropic 格式
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === 'thinking' && (block.thinking || block.text)) {
              reqReasoningTexts.push(block.thinking || block.text);
            }
          }
        }
      }
    }

    // 提取请求中最后一条 assistant 消息的工具调用
    // OpenAI: tool_calls[].function.name; Anthropic: content[].type='tool_use'
    const toolCallNames = [];
    if (req.messages) {
      const assistantMsgs = req.messages.filter((m) => m.role === 'assistant');
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      // OpenAI 格式
      if (lastAssistant?.tool_calls) {
        for (const tc of lastAssistant.tool_calls) {
          if (tc.function?.name) toolCallNames.push(tc.function.name);
        }
      }
      // Anthropic 格式
      if (Array.isArray(lastAssistant?.content)) {
        for (const block of lastAssistant.content) {
          if (block.type === 'tool_use' && block.name) toolCallNames.push(block.name);
        }
      }
    }

    // 提取 response content、reasoning、toolCalls
    let responseContent = '';
    let responseReasoning = '';
    let responseToolCalls = [];
    if (d.response.streaming && d.response.parsed) {
      responseContent = d.response.parsed.content || '';
      responseReasoning = d.response.parsed.reasoning || '';
      responseToolCalls = d.response.parsed.toolCalls || [];
    } else if (d.response.body) {
      if (typeof d.response.body === 'string' && d.response.body.includes('data: ')) {
        const lines = d.response.body.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            for (const choice of obj.choices || []) {
              if (choice.delta?.content) responseContent += choice.delta.content;
            }
          } catch {}
        }
      } else if (typeof d.response.body === 'object') {
        const content = d.response.body.content;
        if (content) {
          responseContent = Array.isArray(content)
            ? content.map((c) => c.text || '').join('')
            : String(content);
        }
      }
    }

    return {
      id: d.id,
      seqIndex: idx,
      timestamp: d.timestamp,
      method: d.method,
      path: d.path,
      duration: d.duration,
      requestModel: req.model,
      responseModel: d.response.parsed?.model || null,
      messageCount: req.messages?.length || 0,
      hasSystemPrompt,
      userContent,
      toolCallNames,
      responseContent,
      responseReasoning,
      responseToolCalls,
      reqReasoningTexts,
      status: d.response.status,
      usage: normalizeUsage(d.response.parsed?.usage),
    };
  });

  return { records, totalRequests: allChatRequests.length, failedRequests: failed.length };
}

// ── 去除 environment_details 和 task_progress 的辅助函数 ──
function stripEnvDetails(text) {
  // 去掉 <environment_details>...</environment_details> 块
  let stripped = text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '');
  // 去掉 <task_progress>...</task_progress> 块
  stripped = stripped.replace(/<task_progress>[\s\S]*?<\/task_progress>/g, '');
  // 去掉 <cache_control>...</cache_control> 块
  stripped = stripped.replace(/<cache_control>[\s\S]*?<\/cache_control>/g, '');
  return stripped.trim();
}

// ── 对比 ──────────────────────────────────────────────
function compare(clientRounds, proxyRecords, clientType, interceptStats) {
  const clientName = clientType === 'claude' ? 'Claude Code' : 'Cline';

  console.log('\n' + '═'.repeat(70));
  console.log(` 📊  对比验证：代理拦截 vs ${clientName} 历史`);
  console.log('═'.repeat(70));

  const filteredNote = interceptStats?.failedRequests
    ? ` (共 ${interceptStats.totalRequests} 条, ${interceptStats.failedRequests} 条失败已过滤)`
    : '';
  console.log(`\n  代理拦截记录: ${proxyRecords.length} 条${filteredNote}`);
  console.log(`  ${clientName} 历史轮数: ${clientRounds.length} 轮`);

  // ── 智能对齐 ────────────────────────────────────────
  // Cline: 用 completion_tokens 匹配
  // Claude Code: 没有 metrics，用顺序匹配
  function alignRounds(proxyRecords, clientRounds, clientType) {
    const pairs = [];

    if (clientType === 'claude') {
      // Claude Code 没有 metrics，用响应内容前缀 + 工具调用匹配
      let clientStart = 0;
      for (const proxy of proxyRecords) {
        const proxyText = proxy.responseContent.trim();
        const proxyTools = proxy.responseToolCalls.map((t) => t.name).sort().join(',');
        let bestIdx = -1;
        for (let j = clientStart; j < clientRounds.length; j++) {
          const clientText = clientRounds[j].assistantContent.trim();
          const clientTools = clientRounds[j].toolUses.map((t) => t.name).sort().join(',');
          if (proxyText && clientText) {
            const len = Math.min(100, proxyText.length, clientText.length);
            if (proxyText.substring(0, len) === clientText.substring(0, len)) { bestIdx = j; break; }
          } else if (!proxyText && !clientText && proxyTools && proxyTools === clientTools) {
            bestIdx = j; break;
          }
        }
        if (bestIdx >= 0) { pairs.push(bestIdx); clientStart = bestIdx + 1; }
        else { pairs.push(null); }
      }
      return pairs;
    }

    // Cline: 用 completion_tokens 链式匹配
    let clientStart = 0;
    for (const proxy of proxyRecords) {
      const proxyComp = proxy.usage?.completion_tokens;
      if (!proxyComp) { pairs.push(null); continue; }

      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let j = clientStart; j < clientRounds.length; j++) {
        const ct = clientRounds[j].metrics?.tokens;
        if (!ct) continue;
        const diff = Math.abs(proxyComp - ct.completion);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = j;
        }
      }
      if (bestIdx >= 0 && bestDiff <= 5) {
        pairs.push(bestIdx);
        clientStart = bestIdx + 1;
      } else {
        pairs.push(null);
      }
    }
    return pairs;
  }

  const alignment = alignRounds(proxyRecords, clientRounds, clientType);

  console.log('\n' + '─'.repeat(70));
  console.log(` 💬  对齐匹配（${clientType === 'claude' ? '基于响应内容匹配' : '基于 completion_tokens 匹配'}）`);
  console.log('─'.repeat(70));

  const results = [];
  let textMatches = 0;
  let tokenMatches = 0;
  let matchedCount = 0;

  for (let i = 0; i < proxyRecords.length; i++) {
    const proxy = proxyRecords[i];
    const clineIdx = alignment[i];
    if (clineIdx === null || clineIdx === undefined) {
      console.log(`\n  ⚠️  拦截 #${i}: 未找到匹配的 ${clientName} 轮次 (completion_tokens=${proxy.usage?.completion_tokens})`);
      continue;
    }
    const client = clientRounds[clineIdx];
    matchedCount++;
    const checks = {};

    // ── 对比 user 消息内容 ────────────────────────────
    const proxyUserStripped = stripEnvDetails(proxy.userContent);
    const clientUserStripped = stripEnvDetails(client.userContent);
    const proxyUserPrefix = proxyUserStripped.substring(0, 200);
    const clientUserPrefix = clientUserStripped.substring(0, 200);
    checks.userContentMatch = proxyUserPrefix === clientUserPrefix
      || (proxyUserStripped.length > 0 && clientUserStripped.length > 0
          && (proxyUserStripped.includes(clientUserPrefix) || clientUserStripped.includes(proxyUserPrefix)));

    // ── 对比 assistant text 回复 ─────────────────────
    const proxyReply = proxy.responseContent.trim();
    const clientReply = client.assistantContent.trim();
    if (proxyReply.length === 0 && clientReply.length === 0) {
      checks.responseMatch = true;
    } else if (proxyReply.length > 0 && clientReply.length > 0) {
      checks.responseMatch = proxyReply.includes(clientReply.substring(0, 100))
        || clientReply.includes(proxyReply.substring(0, 100));
    } else {
      // 一边有内容一边没有
      checks.responseMatch = false;
    }
    if (checks.responseMatch) textMatches++;

    // ── 对比 model ───────────────────────────────────
    checks.modelMatch = !client.modelId || proxy.requestModel === client.modelId;
    checks.proxyModel = proxy.requestModel;
    checks.clientModel = client.modelId;
    checks.actualModel = proxy.responseModel;

    // ── 对比 tokens ──────────────────────────────────
    if (proxy.usage && client.metrics?.tokens) {
      const pu = proxy.usage;
      const ct = client.metrics.tokens;

      // Cline prompt = 非缓存部分; proxy prompt_tokens = 总数 (含缓存)
      const clinePromptTotal = (ct.prompt || 0) + (ct.cached || 0);
      const promptMatch = pu.prompt_tokens === clinePromptTotal;
      const compMatch = pu.completion_tokens === ct.completion;
      if (promptMatch && compMatch) tokenMatches++;

      checks.tokensProxy = {
        prompt: pu.prompt_tokens,
        completion: pu.completion_tokens,
        reasoningTokens: pu.completion_tokens_details?.reasoning_tokens || 0,
      };
      checks.tokensCline = {
        prompt: ct.prompt,
        completion: ct.completion,
        cached: ct.cached,
        promptTotal: clinePromptTotal,
      };
      checks.promptMatch = promptMatch;
      checks.completionMatch = compMatch;
    }

    // ── Thinking / Reasoning 信息 ───────────────────
    checks.thinkingInfo = {
      clientHasThinking: client.thinkingText.length > 0,
      clientThinkingLength: client.thinkingText.length,
      proxyHasReasoning: proxy.responseReasoning.length > 0,
      proxyReasoningLength: proxy.responseReasoning.length,
      proxyReasoningTokens: proxy.usage?.completion_tokens_details?.reasoning_tokens || 0,
      // 代理请求中携带的历史 reasoning_details（前几轮的 thinking）
      proxyReqReasoningCount: proxy.reqReasoningTexts.length,
    };

    // ── 响应中的工具调用 ──────────────────────────────
    const clientResponseTools = client.toolUses.map((t) => t.name).sort();
    const proxyResponseTools = proxy.responseToolCalls.map((t) => t.name).sort();
    checks.responseToolMatch = JSON.stringify(clientResponseTools) === JSON.stringify(proxyResponseTools);
    checks.clientResponseTools = clientResponseTools;
    checks.proxyResponseTools = proxyResponseTools;

    results.push({ proxy, client, checks });
  }

  // ── 打印匹配结果 ────────────────────────────────────
  for (const r of results) {
    const c = r.checks;
    console.log('\n' + '─'.repeat(70));
    console.log(`  💬 拦截 #${r.proxy.seqIndex} → ${clientName} 轮次 #${r.client.index}`);
    console.log(`     时间: ${r.proxy.timestamp}  耗时: ${r.proxy.duration}ms`);

    // Model
    const modelIcon = c.modelMatch ? '✅' : '⚠️';
    console.log(`     ${modelIcon} 请求模型: 代理=${c.proxyModel}${c.clientModel ? `  ${clientName}=${c.clientModel}` : ''}`);
    if (c.actualModel && c.actualModel !== c.proxyModel) {
      console.log(`     ℹ️  实际响应模型: ${c.actualModel}`);
    }

    // User content
    console.log(`     ${c.userContentMatch ? '✅' : '❌'} User 消息内容: ${c.userContentMatch ? '一致' : '不一致'}`);

    // Response
    console.log(`     ${c.responseMatch ? '✅' : '⚠️'} Assistant 回复(text): ${c.responseMatch ? '一致' : '需人工确认'}`);
    if (r.proxy.responseContent) {
      const preview = r.proxy.responseContent.substring(0, 80).replace(/\n/g, ' ');
      console.log(`        代理: "${preview}${r.proxy.responseContent.length > 80 ? '...' : ''}"`);
    }
    if (r.client.assistantContent) {
      const preview = r.client.assistantContent.substring(0, 80).replace(/\n/g, ' ');
      console.log(`        ${clientName}: "${preview}${r.client.assistantContent.length > 80 ? '...' : ''}"`);
    }

    // Tool calls
    if (c.clientResponseTools.length > 0 || c.proxyResponseTools.length > 0) {
      console.log(`     ${c.responseToolMatch ? '✅' : '⚠️'} 工具调用: ${clientName}=[${c.clientResponseTools.join(', ')}]  代理=[${c.proxyResponseTools.join(', ')}]`);
    }

    // Tokens
    if (c.tokensProxy && c.tokensCline) {
      const tp = c.tokensProxy;
      const tc = c.tokensCline;
      console.log(`     ${c.promptMatch ? '✅' : '⚠️'} Prompt tokens:  代理=${tp.prompt}  ${clientName}=${tc.prompt}(非缓存)+${tc.cached}(缓存)=${tc.promptTotal}`);
      console.log(`     ${c.completionMatch ? '✅' : '⚠️'} Completion tokens: 代理=${tp.completion}  ${clientName}=${tc.completion}`);
      if (tp.reasoningTokens > 0) {
        console.log(`     ℹ️  Reasoning tokens (代理): ${tp.reasoningTokens}`);
      }
    }

    // Thinking / Reasoning
    if (c.thinkingInfo.clientHasThinking || c.thinkingInfo.proxyHasReasoning || c.thinkingInfo.proxyReasoningTokens > 0) {
      const cIcon = c.thinkingInfo.clientHasThinking ? '✅' : '❌';
      const pIcon = c.thinkingInfo.proxyHasReasoning ? '✅' : '❌';
      console.log(`     🧠 推理: ${clientName}=${cIcon}(${c.thinkingInfo.clientThinkingLength}字符)  代理=${pIcon}(${c.thinkingInfo.proxyReasoningLength}字符)  reasoning_tokens=${c.thinkingInfo.proxyReasoningTokens}`);
    }
  }

  // ── 未匹配的轮次 ────────────────────────────────────
  const matchedIndices = new Set(alignment.filter((v) => v !== null));
  const unmatchedClient = clientRounds.filter((_, i) => !matchedIndices.has(i));
  if (unmatchedClient.length > 0) {
    console.log('\n' + '─'.repeat(70));
    console.log(` ⚠️  未匹配的 ${clientName} 轮次（无对应代理拦截）`);
    console.log('─'.repeat(70));
    for (const cl of unmatchedClient) {
      const tools = cl.toolUses.map((t) => t.name).join(', ');
      const preview = cl.assistantContent.substring(0, 80).replace(/\n/g, ' ');
      console.log(`\n  ⚠️  ${clientName} 轮次 #${cl.index}`);
      console.log(`     工具: [${tools}]`);
      console.log(`     回复: "${preview}${cl.assistantContent.length > 80 ? '...' : ''}"`);
    }
  }

  // ── 统计 ───────────────────────────────────────────
  const responseOk = textMatches;
  const modelOk = results.filter((r) => r.checks.modelMatch).length;
  const toolMatchOk = results.filter((r) => r.checks.responseToolMatch).length;

  // ── 总结 ────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(' 📋  总结');
  console.log('═'.repeat(70));

  console.log(`  代理拦截: ${proxyRecords.length} 条${interceptStats?.failedRequests ? ` (+ ${interceptStats.failedRequests} 条失败已过滤)` : ''}`);
  console.log(`  ${clientName} 轮次: ${clientRounds.length} 轮`);
  console.log(`  匹配: ${matchedCount} 轮`);
  if (unmatchedClient.length > 0) {
    console.log(`  未匹配: ${unmatchedClient.length} 轮`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log(' 📌  整体指标');
  console.log('─'.repeat(70));

  // 1. System Prompt
  const proxyHasSystem = proxyRecords.every((r) => r.hasSystemPrompt);
  console.log(`\n  1️⃣  System Prompt:`);
  console.log(`     代理拦截: ${proxyHasSystem ? '✅ 每轮都有' : '⚠️ 部分缺失'}`);
  console.log(`     ${clientName} 历史: ❌ 不记录 system prompt（仅 API 请求中携带）`);

  // 2. 数据缺失
  console.log(`\n  2️⃣  数据缺失对比:`);
  const proxyMissing = [];
  const clientMissing = ['system prompt（不记录）'];
  if (unmatchedClient.length > 0) proxyMissing.push(`${unmatchedClient.length} 轮未被拦截`);
  const proxyNoContent = results.filter((r) => !r.proxy.responseContent && r.client.assistantContent).length;
  const clientNoContent = results.filter((r) => r.proxy.responseContent && !r.client.assistantContent).length;
  if (proxyNoContent > 0) proxyMissing.push(`${proxyNoContent} 轮响应 text 为空（仅有工具调用）`);
  if (clientNoContent > 0) clientMissing.push(`${clientNoContent} 轮响应 text 为空`);
  console.log(`     代理缺失: ${proxyMissing.length === 0 ? '✅ 无' : proxyMissing.join('；')}`);
  console.log(`     ${clientName}缺失: ${clientMissing.join('；')}`);

  // 3. 推理部分
  console.log(`\n  3️⃣  推理(Thinking/Reasoning):`);
  const clientThinkingRounds = results.filter((r) => r.checks.thinkingInfo.clientHasThinking).length;
  const proxyReasoningRounds = results.filter((r) => r.checks.thinkingInfo.proxyHasReasoning).length;
  const proxyReasoningTokenRounds = results.filter((r) => r.checks.thinkingInfo.proxyReasoningTokens > 0).length;
  console.log(`     ${clientName}: ${clientThinkingRounds}/${matchedCount} 轮有 thinking 文本${clientThinkingRounds > 0 ? ' ✅' : ' ❌'}`);
  console.log(`     代理 SSE 响应: ${proxyReasoningRounds}/${matchedCount} 轮有 reasoning 文本${proxyReasoningRounds > 0 ? ' ✅' : ' ❌'}`);
  console.log(`     代理 reasoning_tokens: ${proxyReasoningTokenRounds}/${matchedCount} 轮有计数`);

  // 4. 工具调用
  console.log(`\n  4️⃣  工具调用:`);
  console.log(`     匹配: ${toolMatchOk}/${matchedCount} 轮一致`);
  const allClientTools = results.flatMap((r) => r.checks.clientResponseTools);
  const allProxyTools = results.flatMap((r) => r.checks.proxyResponseTools);
  console.log(`     ${clientName} 总调用: ${allClientTools.length} 次 [${[...new Set(allClientTools)].join(', ')}]`);
  console.log(`     代理 总调用: ${allProxyTools.length} 次 [${[...new Set(allProxyTools)].join(', ')}]`);
  if (toolMatchOk === matchedCount) {
    console.log(`     ✅ 工具调用完全一致`);
  } else {
    for (const r of results) {
      if (!r.checks.responseToolMatch) {
        console.log(`     ⚠️  轮次 #${r.client.index}: ${clientName}=[${r.checks.clientResponseTools.join(',')}] 代理=[${r.checks.proxyResponseTools.join(',')}]`);
      }
    }
  }

  // ── 总体结论 ────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log(`  回复text一致: ${responseOk}/${matchedCount}`);
  console.log(`  模型一致: ${modelOk}/${matchedCount}`);

  const allGood = responseOk === matchedCount
    && modelOk === matchedCount
    && toolMatchOk === matchedCount;

  console.log(`\n  ${allGood ? `✅ 验证通过：代理拦截与 ${clientName} 记录核心数据一致` : '⚠️  存在差异，请检查上方详情'}`);
  console.log('═'.repeat(70) + '\n');

  // 保存报告
  const reportPath = path.join(__dirname, 'test-results', 'verification-result.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    clientType,
    summary: {
      proxyIntercepts: proxyRecords.length,
      totalRequests: interceptStats?.totalRequests || proxyRecords.length,
      failedRequests: interceptStats?.failedRequests || 0,
      clientRounds: clientRounds.length,
      matched: matchedCount,
      responseOk, modelOk, toolMatchOk, tokenMatches,
      systemPrompt: { proxy: proxyHasSystem, client: false },
      thinking: { clientThinkingRounds, proxyReasoningRounds, proxyReasoningTokenRounds },
      allGood,
    },
    details: results.map((r) => ({
      proxyIndex: r.proxy.seqIndex,
      clientRound: r.client.index,
      proxyTime: r.proxy.timestamp,
      checks: r.checks,
    })),
  }, null, 2));
  console.log(`  💾 详细报告: ${reportPath}\n`);
}

// ── 主函数 ────────────────────────────────────────────
function main() {
  // 加载代理拦截数据
  if (!fs.existsSync(INTERCEPT_FILE)) {
    console.error('❌ 未找到拦截数据，请先通过代理运行 Cline/Claude Code');
    process.exit(1);
  }

  // 检测客户端类型
  const args = process.argv.slice(2);
  let clientType = detectClient(INTERCEPT_FILE);
  let taskOrSessionId = null;

  if (args[0] === '--claude') {
    clientType = 'claude';
    taskOrSessionId = args[1] || null;
  } else if (args[0] === '--cline') {
    clientType = 'cline';
    taskOrSessionId = args[1] || null;
  } else if (args[0]) {
    taskOrSessionId = args[0];
  }

  console.log(`🔍 检测到客户端: ${clientType === 'claude' ? 'Claude Code' : 'Cline'}`);

  let historyFile, clientRounds;
  if (clientType === 'claude') {
    historyFile = findClaudeHistory(taskOrSessionId);
    console.log(`📂 Claude Code 历史: ${historyFile}`);
    clientRounds = parseClaudeHistory(historyFile);
  } else {
    historyFile = findClineHistory(taskOrSessionId);
    console.log(`📂 Cline 历史: ${historyFile}`);
    clientRounds = parseClineHistory(historyFile);
  }
  console.log(`📂 代理拦截: ${INTERCEPT_FILE}`);

  const interceptResult = parseIntercepts(INTERCEPT_FILE);
  compare(clientRounds, interceptResult.records, clientType, interceptResult);
}

main();
