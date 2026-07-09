const state = {
  sessions: [],
  currentSession: null,
  currentOverview: null,
  proxyRunning: false,
  certPath: '',
  lastInterceptRecords: [],
  statusTimer: null,
  sortField: null,
  sortDir: 'asc',
  terminal: { term: null, ws: null, fit: null, ready: false, connecting: false, shell: '', currentShell: '', cwd: '' },
  replay: { data: null, selected: null, onlyProblems: false },
};

const $ = (id) => document.getElementById(id);

/* ===== Toast ===== */
function showToast(message, type = 'info', duration = 3000) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* ===== API ===== */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data.error || data || `HTTP ${res.status}`);
  return data;
}

function metric(label, value, cls = '') {
  return `<span class="metric ${cls}">${label}: ${value}</span>`;
}

function renderMetrics(el, entries) {
  el.innerHTML = entries.map(([label, value, cls]) => metric(label, value, cls)).join('');
}

function currentSessionId() {
  const id = $('sessionSelect').value;
  if (!id) throw new Error('请先创建或选择 session');
  return id;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function displayPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function localTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function tokenText(tokens) {
  if (!tokens) return '-';
  const prompt = tokens.prompt_tokens ?? tokens.input_tokens ?? '-';
  const completion = tokens.completion_tokens ?? tokens.output_tokens ?? '-';
  const reasoning = tokens.completion_tokens_details?.reasoning_tokens;
  return reasoning ? `${prompt}/${completion}/${reasoning}` : `${prompt}/${completion}`;
}

/* ===== Log highlight ===== */
function highlightLog(line) {
  let s = escapeHtml(line);
  s = s.replace(/\[(\d{1,2}:\d{2}:\d{2}\s*[AP]M?)\]/g, '<span class="log-time">[$1]</span>');
  s = s.replace(/\b(Proxy|proxy)\b/g, '<span class="log-proxy">$1</span>');
  s = s.replace(/\b(error|Error|ERROR|failed|Failed|exited)\b/g, '<span class="log-err">$1</span>');
  s = s.replace(/\b(started|Created|Imported|running)\b/g, '<span class="log-info">$1</span>');
  return s;
}

/* ===== Status refresh ===== */
async function refreshStatus() {
  const status = await api('/api/status');
  const wasRunning = state.proxyRunning;
  state.sessions = status.sessions;
  state.proxyRunning = status.proxyRunning;
  state.certPath = status.certs.certPath || '';
  state.picDir = (status.certs && status.certs.picDir) ? status.certs.picDir : '';
  const proxy = $('proxyStatus');
  proxy.textContent = status.proxyRunning ? '◉ Proxy: running' : '○ Proxy: stopped';
  proxy.classList.toggle('running', status.proxyRunning);
  proxy.classList.toggle('stopped', !status.proxyRunning);
  setProxyButtonState(status.proxyRunning);
  const certHint = $('certHint');
  if (certHint) {
    if (status.certs.certExists && status.certs.keyExists) {
      certHint.textContent = '证书已就绪';
      certHint.className = 'hint inline ok';
    } else {
      certHint.textContent = '证书缺失，请运行 node setup-https-proxy.js';
      certHint.className = 'hint inline bad';
    }
  }
  // 日志自动滚到底部
  const logEl = $('logs');
  const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 10;
  logEl.innerHTML = status.logs.map(highlightLog).join('\n');
  if (state.logAutoScroll !== false || wasAtBottom) {
    logEl.scrollTop = logEl.scrollHeight;
  }

  const select = $('sessionSelect');
  const previous = select.value || state.currentSession;
  select.innerHTML = state.sessions.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (state.sessions.length) {
    select.value = state.sessions.some((s) => s.id === previous) ? previous : state.sessions[0].id;
    state.currentSession = select.value;
    await refreshSession();
  } else {
    state.currentSession = null;
    openNewSessionModal();
  }
  if (status.proxyRunning && document.querySelector('#workspaceA.active')) {
    loadIntercepts({ quiet: true }).catch(() => {});
  }
  // Proxy just stopped — auto-refresh intercepts
  if (wasRunning && !status.proxyRunning) {
    loadIntercepts().catch(() => {});
  }
}

async function refreshSession() {
  const id = $('sessionSelect').value;
  if (!id) return;
  if (state.replay.data && state.replay.data.sessionId !== id) {
    state.replay.data = null;
    state.replay.selected = null;
    if (document.querySelector('#workspaceD.active')) renderReplay();
  }
  const overview = await api(`/api/sessions/${id}`);
  state.currentOverview = overview;
  const fileIcons = {
    'config.json':              { icon: '⚙', label: '配置' },
    'https-intercepts.json':    { icon: '⬇', label: '抓包' },
    'claude-history.jsonl':     { icon: '📜', label: '历史' },
    'verification-result.json': { icon: '🔍', label: '验证' },
    'instance.json':            { icon: '📋', label: '实例' },
    'trajectory.jsonl':         { icon: '📊', label: '轨迹' },
    'qc-report.json':           { icon: '✅', label: '质检' },
  };
  $('sessionFiles').innerHTML = overview.files.map((f) => {
    const meta = fileIcons[f.name] || { icon: '📄', label: f.name };
    const cls = f.exists ? 'file-row ok' : 'file-row missing';
    const dotCls = f.exists ? 'file-dot ok' : 'file-dot missing';
    const sizeText = f.exists ? formatBytes(f.size) : '未生成';
    const status = `<span class="file-status"><span class="${dotCls}"></span><span class="file-size">${sizeText}</span></span>`;
    return `<div class="${cls}">
      <span class="file-icon">${meta.icon}</span>
      <span class="file-label">${meta.label}</span>
      <span class="file-name">${escapeHtml(f.name)}</span>
      ${status}
    </div>`;
  }).join('');
  $('sessionSummary').innerHTML = renderSessionSummary(overview);
  // Session 数据管理面板的状态速览
  const statusMetrics = [];
  if (overview.interceptSummary) {
    statusMetrics.push(
      ['抓包请求', overview.interceptSummary.successfulRequests, overview.interceptSummary.successfulRequests ? 'ok' : ''],
      ['失败', overview.interceptSummary.failedRequests, overview.interceptSummary.failedRequests ? 'warn' : 'ok'],
    );
  } else {
    statusMetrics.push(['抓包请求', '未导入', '']);
  }
  if (overview.historySummary) {
    statusMetrics.push(
      ['对话轮次', overview.historySummary.rounds, 'ok'],
      ['思考轮次', overview.historySummary.thinkingRounds, overview.historySummary.thinkingRounds ? 'ok' : ''],
    );
  } else {
    statusMetrics.push(['对话轮次', '未导入', '']);
  }
  const hasVerification = overview.files?.find((f) => f.name === 'verification-result.json')?.exists;
  const hasDelivery = ['instance.json', 'trajectory.jsonl'].every((name) =>
    overview.files?.find((f) => f.name === name)?.exists
  );
  statusMetrics.push(
    ['验证', hasVerification ? '已完成' : '未验证', hasVerification ? 'ok' : ''],
    ['交付', hasDelivery ? '已生成' : '未生成', hasDelivery ? 'ok' : ''],
  );
  renderMetrics($('dataStatusMetrics'), statusMetrics);

  if (overview.interceptSummary) {
    renderMetrics($('captureMetrics'), [
      ['成功对话请求', overview.interceptSummary.successfulRequests, 'ok'],
      ['失败请求', overview.interceptSummary.failedRequests, overview.interceptSummary.failedRequests ? 'warn' : 'ok'],
      ['总抓包', overview.interceptSummary.totalInterceptions, ''],
      ['目标 Host', overview.interceptSummary.targetHost || '*', ''],
    ]);
  }
  loadMetadataDraft();
  if (document.querySelector('#workspaceD.active') && (!state.replay.data || state.replay.data.sessionId !== id)) {
    loadReplay({ quiet: true }).catch((err) => {
      showToast(err.message || '回放加载失败', 'error', 3000);
    });
  }
}

function renderSessionSummary(overview) {
  const parts = [`<div class="summary-title">Session 状态</div>`];
  parts.push(`<div>目录：${escapeHtml(displayPath(overview.path))}</div>`);
  if (overview.historySummary) {
    parts.push(`<div>History：${overview.historySummary.rounds} 轮，thinking ${overview.historySummary.thinkingRounds} 轮</div>`);
    parts.push(`<div>Tools：${escapeHtml((overview.historySummary.tools || []).join(', ') || 'none')}</div>`);
  } else {
    parts.push('<div>History：未导入</div>');
  }
  if (overview.interceptSummary) {
    parts.push(`<div>抓包：${overview.interceptSummary.successfulRequests} 成功 / ${overview.interceptSummary.failedRequests} 失败</div>`);
  } else {
    parts.push('<div>抓包：未生成</div>');
  }
  return parts.join('');
}

async function createSession(name) {
  const sessionName = name || $('sessionName').value;
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: sessionName }),
  });
  state.currentSession = created.id;
  await refreshStatus();
  $('sessionSelect').value = created.id;
  await refreshSession();
  showToast('Session 创建成功', 'success');
}

async function renameSession() {
  const id = currentSessionId();
  const current = state.sessions.find((s) => s.id === id);
  const name = prompt('输入新的 Session 名称（会同时重命名目录）', current?.name || id);
  if (!name || !name.trim()) return;
  const result = await api(`/api/sessions/${id}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name: name.trim() }),
  });
  await refreshStatus();
  // 切到新 ID
  if (result && result.id) {
    state.currentSession = result.id;
    $('sessionSelect').value = result.id;
  }
  showToast('Session 已重命名', 'success');
}

async function clearSession() {
  if (!confirm('确认清除当前工作台显示的抓包数据、验证结果和交付预览？\n\n只是清空页面显示，不会删除 Session 里已保存的文件。')) return;
  $('interceptsTable').innerHTML = '';
  $('verifyMetrics').innerHTML = '';
  $('verifyTable').innerHTML = '';
  $('verifyResult').textContent = '';
  $('deliveryPreview').textContent = '';
  $('qcMetrics').innerHTML = '';
  $('qcDetails').innerHTML = '';
  showToast('工作台显示已清空，文件未删除', 'success');
}

async function clearHistory() {
  if (!confirm('确认删除当前 Session 的 claude-history.jsonl 文件？\n\n删除后可以重新导入正确的历史。')) return;
  try {
    await api(`/api/sessions/${currentSessionId()}/clear-history`, { method: 'POST' });
    await refreshStatus();
    showToast('历史文件已删除', 'success');
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

async function deleteSession() {
  const id = currentSessionId();
  if (!confirm(`确认删除 Session ${id}？\n\n该操作会删除本 session 下的抓包、历史、验证、交付文件。`)) return;
  await api(`/api/sessions/${id}`, { method: 'DELETE' });
  state.currentSession = null;
  await refreshStatus();
  showToast('Session 已删除', 'success');
}

async function openSessionDir() {
  await api(`/api/sessions/${currentSessionId()}/open-dir`, { method: 'POST', body: '{}' });
  showToast('已请求打开 Session 目录', 'info');
}

async function importSession() {
  const targetId = currentSessionId();
  if (!state.sessions.length) {
    showToast('没有可导入的 Session', 'warn');
    return;
  }
  const body = $('historyPickerBody');
  body.innerHTML = state.sessions
    .filter((s) => s.id !== targetId)
    .map((s) => `
      <button class="history-item" data-sid="${escapeHtml(s.id)}">
        <span>${escapeHtml(s.name)}</span>
        <small>${escapeHtml(s.id)} · ${s.hasIntercepts ? '含抓包' : ''} ${s.hasHistory ? '含历史' : ''}</small>
      </button>
    `).join('');
  if (!body.innerHTML) {
    body.innerHTML = emptyState('⌕', '没有其他 Session 可导入');
  } else {
    body.querySelectorAll('.history-item').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('导入将覆盖当前 Session 的抓包和历史文件，继续吗？')) return;
        await api(`/api/sessions/${targetId}/import`, {
          method: 'POST',
          body: JSON.stringify({ fromSessionId: btn.dataset.sid }),
        });
        closeHistoryPicker();
        await refreshStatus();
        await loadIntercepts();
        showToast('导入完成，正在自动验证…', 'success');
        try { await runVerify(); } catch {}
      });
    });
  }
  openHistoryPicker();
}

async function importPaths() {
  if (state.currentOverview?.files?.some((f) => f.exists && ['https-intercepts.json', 'claude-history.jsonl'].includes(f.name))) {
    if (!confirm('当前 Session 已有抓包或历史文件，导入路径会覆盖对应文件。继续吗？')) return;
  }
  await api(`/api/sessions/${currentSessionId()}/import`, {
    method: 'POST',
    body: JSON.stringify({
      interceptsPath: $('interceptsPath').value,
      historyPath: $('historyPath').value,
    }),
  });
  await refreshStatus();
  await loadIntercepts();
  showToast('文件导入完成', 'success');
}

async function setupCert() {
  await api('/api/certs/setup', { method: 'POST', body: '{}' });
  await refreshStatus();
  showToast('证书生成任务已启动', 'info');
}

function getProxyEnv(port) {
  const cert = displayPath(state.certPath || '');
  return { port, cert };
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback：某些环境 clipboard API 不可用
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  showToast(label + ' 已复制', 'success');
}

// ── One-click: jump to terminal + run proxy setup ──────

function waitForTerminal(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = state.terminal;
    if (t.ready && t.ws && t.ws.readyState === 1) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (t.ready && t.ws && t.ws.readyState === 1) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error('终端连接超时'));
      }
    }, 150);
  });
}

function sendToTerminal(lines, delayMs = 0) {
  const ws = state.terminal.ws;
  if (!ws || ws.readyState !== 1) return;
  const send = () => {
    for (const line of lines) {
      ws.send(line + '\r\n');
    }
  };
  if (delayMs > 0) { setTimeout(send, delayMs); } else { send(); }
}

async function launchInTerminal(shell, shellLabel, envLines) {
  const t = state.terminal;

  // 1. Set the target shell
  t.shell = shell;
  document.querySelectorAll('.shell-btn').forEach((btn) => {
    btn.classList.toggle('active-shell', btn.dataset.shell === shell);
  });

  // 2. Switch to Workspace C (this triggers lazy initTerminal via tab handler)
  document.querySelector('.tab[data-tab="workspaceC"]').click();

  // 3. Decide: init, restart, or wait for in-progress connection
  if (!t.term) {
    // Never initialized
    initTerminal();
  } else if (t.connecting) {
    // Connection in progress — if shell matches, just wait; if not, restart
    if (t.shell !== shell) restartTerminal();
  } else if (!t.ready || t.currentShell !== shell) {
    // Disconnected or wrong shell
    restartTerminal();
  }

  // 4. Wait for terminal WS to be open
  try {
    await waitForTerminal();
    t.currentShell = shell;

    // 5. Give the shell time to finish init (bash --login can take 500ms+)
    //    before sending commands, otherwise they get swallowed by profile scripts
    const toSend = envLines.filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('rem '));
    toSend.push('claude --permission-mode bypassPermissions');
    sendToTerminal(toSend, 800);
    showToast(`已发送到 ${shellLabel} 终端`, 'info', 2500);
  } catch (err) {
    showToast(err.message || '终端连接失败', 'error', 4000);
  }
}

async function copyBashCommand() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const envLines = [
    `export HTTP_PROXY=http://127.0.0.1:${port}`,
    `export HTTPS_PROXY=http://127.0.0.1:${port}`,
    `export http_proxy=http://127.0.0.1:${port}`,
    `export https_proxy=http://127.0.0.1:${port}`,
    `export ALL_PROXY=http://127.0.0.1:${port}`,
    `export NODE_EXTRA_CA_CERTS="${cert}"`,
    `export NODE_TLS_REJECT_UNAUTHORIZED=0`,
  ];
  await launchInTerminal('bash', 'Git Bash', envLines);
}

async function copyPSCommand() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const envLines = [
    `$env:HTTP_PROXY="http://127.0.0.1:${port}"`,
    `$env:HTTPS_PROXY="http://127.0.0.1:${port}"`,
    `$env:http_proxy="http://127.0.0.1:${port}"`,
    `$env:https_proxy="http://127.0.0.1:${port}"`,
    `$env:ALL_PROXY="http://127.0.0.1:${port}"`,
    `$env:NODE_EXTRA_CA_CERTS="${cert}"`,
    `$env:NODE_TLS_REJECT_UNAUTHORIZED="0"`,
  ];
  await launchInTerminal('powershell.exe', 'PowerShell', envLines);
}

async function copyCMDCommand() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const envLines = [
    `set HTTP_PROXY=http://127.0.0.1:${port}`,
    `set HTTPS_PROXY=http://127.0.0.1:${port}`,
    `set http_proxy=http://127.0.0.1:${port}`,
    `set https_proxy=http://127.0.0.1:${port}`,
    `set ALL_PROXY=http://127.0.0.1:${port}`,
    `set NODE_EXTRA_CA_CERTS=${cert}`,
    `set NODE_TLS_REJECT_UNAUTHORIZED=0`,
  ];
  await launchInTerminal('cmd.exe', 'CMD', envLines);
}

async function copyBashOnly() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const cmd = `export HTTP_PROXY=http://127.0.0.1:${port}\nexport HTTPS_PROXY=http://127.0.0.1:${port}\nexport http_proxy=http://127.0.0.1:${port}\nexport https_proxy=http://127.0.0.1:${port}\nexport ALL_PROXY=http://127.0.0.1:${port}\nexport NODE_EXTRA_CA_CERTS="${cert}"\nexport NODE_TLS_REJECT_UNAUTHORIZED=0\nclaude --permission-mode bypassPermissions`;
  await navigator.clipboard.writeText(cmd);
  showToast('Git Bash 命令已复制', 'info', 2000);
}
async function copyPSOnly() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const cmd = `$env:HTTP_PROXY="http://127.0.0.1:${port}"\n$env:HTTPS_PROXY="http://127.0.0.1:${port}"\n$env:http_proxy="http://127.0.0.1:${port}"\n$env:https_proxy="http://127.0.0.1:${port}"\n$env:ALL_PROXY="http://127.0.0.1:${port}"\n$env:NODE_EXTRA_CA_CERTS="${cert}"\n$env:NODE_TLS_REJECT_UNAUTHORIZED="0"\nclaude --permission-mode bypassPermissions`;
  await navigator.clipboard.writeText(cmd);
  showToast('PowerShell 命令已复制', 'info', 2000);
}
async function copyCMDOnly() {
  const { port, cert } = getProxyEnv(Number($('proxyPort').value || 8888));
  const cmd = `set HTTP_PROXY=http://127.0.0.1:${port}\nset HTTPS_PROXY=http://127.0.0.1:${port}\nset http_proxy=http://127.0.0.1:${port}\nset https_proxy=http://127.0.0.1:${port}\nset ALL_PROXY=http://127.0.0.1:${port}\nset NODE_EXTRA_CA_CERTS=${cert}\nset NODE_TLS_REJECT_UNAUTHORIZED=0\nclaude --permission-mode bypassPermissions`;
  await navigator.clipboard.writeText(cmd);
  showToast('CMD 命令已复制', 'info', 2000);
}

async function startProxy() {
  await api('/api/proxy/start', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: currentSessionId(),
      port: Number($('proxyPort').value || 8888),
      targetHost: $('targetHost').value.trim(),
    }),
  });
  await refreshStatus();
  showToast('代理已启动', 'success');
}

function setProxyButtonState(running) {
  const startBtn = $('startProxy');
  const stopBtn = $('stopProxy');
  if (running) {
    startBtn.classList.add('btn-running');
    startBtn.innerHTML = '<span class="btn-icon">◉</span>代理中';
    stopBtn.classList.add('btn-stop');
    stopBtn.classList.remove('disabled');
  } else {
    startBtn.classList.remove('btn-running');
    startBtn.innerHTML = '<span class="btn-icon">▶</span>启动代理';
    stopBtn.classList.remove('btn-stop');
    stopBtn.classList.add('disabled');
  }
}

async function stopProxy() {
  if (state.currentOverview?.interceptSummary?.totalInterceptions) {
    if (!confirm('确认停止代理？当前抓包数据会保存在 Session 中。')) return;
  }
  setProxyButtonState(false);
  try {
    await api('/api/proxy/stop', { method: 'POST', body: '{}' });
  } catch {
    setProxyButtonState(true);
    throw new Error('停止失败');
  }
  await refreshStatus();
  await loadIntercepts();
  showToast('代理已停止，抓包数据已刷新', 'info');
}

async function startProxyWrapped() {
  await startProxy();
  setProxyButtonState(true);
}

async function shutdownWorkbench() {
  if (!confirm('确定关闭工作台？将停止代理并退出后台服务，需重新运行 npm run workbench 才能再次使用。')) return;
  if (state.statusTimer) clearInterval(state.statusTimer);
  try {
    await api('/api/shutdown', { method: 'POST', body: '{}' });
  } catch (_) { /* server already exiting */ }
  showToast('工作台正在关闭…', 'info');
  setTimeout(() => {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;flex-direction:column;min-height:100vh;font-family:sans-serif;color:#8a8a9a;font-size:15px;gap:8px;"><div style="font-size:28px">✦</div><div>工作台已关闭，可关闭此页面</div><div style="font-size:12px;color:#bbb">重新启动请在终端运行 npm run workbench</div></div>';
  }, 400);
}

/* ===== Empty state ===== */
function emptyState(icon, line) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-line">${line}</div></div>`;
}

function sortRecords(records, field, dir) {
  if (!field) return records;
  const getter = {
    seqIndex: r => r.seqIndex,
    status: r => r.status,
    model: r => (r.requestModel || r.responseModel || ''),
    path: r => (r.path || ''),
    duration: r => (typeof r.duration === 'number' ? r.duration : parseInt(r.duration) || 0),
    reasoningLength: r => (typeof r.reasoningLength === 'number' ? r.reasoningLength : parseInt(r.reasoningLength) || 0),
  }[field];
  if (!getter) return records;
  const sorted = [...records].sort((a, b) => {
    const va = getter(a), vb = getter(b);
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb));
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

async function loadIntercepts(options = {}) {
  const data = await api(`/api/sessions/${currentSessionId()}/intercepts`);
  state.lastInterceptRecords = data.records;
  renderMetrics($('captureMetrics'), [
    ['成功对话请求', data.stats.successfulRequests, 'ok'],
    ['失败请求', data.stats.failedRequests, data.stats.failedRequests ? 'warn' : 'ok'],
    ['总抓包', data.stats.totalInterceptions, ''],
    ['目标 Host', data.stats.targetHost || '*', ''],
  ]);
  const sorted = sortRecords(data.records, state.sortField, state.sortDir);
  const tbody = $('interceptsTable');
  // Preserve header row
  const headerRow = tbody.querySelector('tr:first-child');
  if (!data.records.length) {
    tbody.innerHTML = `<tr><td colspan="9">${emptyState('📡', '还没有抓包数据，先启动代理采集吧~')}</td></tr>`;
  } else {
    tbody.innerHTML = sorted.map((r) => `
      <tr class="clickable-row" data-index="${r.seqIndex}">
        <td>${r.seqIndex}</td>
        <td>${r.status}</td>
        <td>${escapeHtml(r.requestModel || r.responseModel || '')}</td>
        <td>${escapeHtml(r.path || '')}</td>
        <td>${r.duration || ''}ms</td>
        <td>${escapeHtml(tokenText(r.tokens))}</td>
        <td>${escapeHtml((r.toolCalls || []).join(', '))}</td>
        <td>${r.reasoningLength}</td>
        <td>${escapeHtml(r.responsePreview || '')}</td>
      </tr>
    `).join('');
  }
  tbody.querySelectorAll('tr[data-index]').forEach((row) => {
    row.addEventListener('click', () => showInterceptDetail(row.dataset.index));
  });
  if (!options.quiet) showToast('抓包数据已刷新', 'info', 1800);
}

async function showInterceptDetail(index) {
  const detail = await api(`/api/sessions/${currentSessionId()}/intercepts/${index}`);
  $('modalTitle').textContent = `抓包详情 #${detail.seqIndex}`;
  $('modalBody').innerHTML = `
    ${detailBlock('请求', [
      ['URL', detail.url],
      ['Path', detail.path],
      ['Status', detail.status],
      ['Duration', `${detail.duration || '-'}ms`],
      ['Request Model', detail.requestModel],
      ['Response Model', detail.responseModel],
      ['Tokens', tokenText(detail.usage)],
    ])}
    ${detailText('System Prompt', detail.systemPrompt, true)}
    ${detailText('User', detail.userContent)}
    ${detailText('Assistant', detail.responseContent)}
    ${detailText('Thinking / Reasoning', detail.responseReasoning)}
    ${detailText('Tool Calls', JSON.stringify(detail.responseToolCalls || [], null, 2))}
  `;
  openModal();
}

function detailBlock(title, rows) {
  return `<section class="detail-section"><h3>${escapeHtml(title)}</h3><div class="detail-grid">${
    rows.map(([k, v]) => `<div class="detail-key">${escapeHtml(k)}</div><div>${escapeHtml(v ?? '-')}</div>`).join('')
  }</div></section>`;
}

function detailText(title, text, collapsed = false) {
  const body = escapeHtml(text || '-');
  return `<section class="detail-section ${collapsed ? 'collapsed-section' : ''}">
    <h3>${escapeHtml(title)}</h3>
    <pre class="detail-pre">${body}</pre>
  </section>`;
}

/* ===== Progress visualization ===== */
function progressRing(pct, label, good) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, pct)));
  const cls = good ? 'good' : (pct >= 1 ? 'good' : 'bad');
  return `<div class="progress-ring ${cls}">
    <svg width="56" height="56"><circle class="bg" cx="28" cy="28" r="${r}" fill="none" stroke-width="5"/>
    <circle class="fg" cx="28" cy="28" r="${r}" fill="none" stroke-width="5" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/></svg>
    <div class="label">${label}</div></div>`;
}

function progressBar(pct, good) {
  const cls = good ? 'good' : (pct >= 1 ? 'good' : '');
  return `<div class="progress-bar ${cls}"><div class="fill" style="width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%"></div></div>`;
}

async function runVerify() {
  const data = await api(`/api/sessions/${currentSessionId()}/verify`, { method: 'POST', body: '{}' });
  const s = data.summary;
  const matchPct = s.clientRounds ? s.matched / s.clientRounds : 0;
  const respPct = s.matched ? s.responseOk / s.matched : 0;
  const toolPct = s.matched ? s.toolMatchOk / s.matched : 0;
  $('verifyMetrics').innerHTML = `
    <div class="progress-wrap">
      ${progressRing(matchPct, `${s.matched}/${s.clientRounds}`, s.allGood)}
      <div class="progress-bars">
        ${metric('回复一致', `${s.responseOk}/${s.matched}`, s.responseOk === s.matched && s.matched > 0 ? 'ok' : 'error')}
        ${metric('工具一致', `${s.toolMatchOk}/${s.matched}`, s.toolMatchOk === s.matched && s.matched > 0 ? 'ok' : 'error')}
        ${metric('Thinking', s.thinking.clientThinkingRounds, s.thinking.clientThinkingRounds ? 'ok' : 'warn')}
        ${metric('失败请求', s.failedRequests, s.failedRequests ? 'warn' : 'ok')}
      </div>
    </div>`;
  $('verifyTable').innerHTML = renderVerifyTable(data);
  bindVerifyReplayLinks();
  $('verifyResult').textContent = JSON.stringify(data, null, 2);
  await refreshSession();
  if (s.allGood) showToast('验证全部通过 ✦', 'success');
  else showToast('验证未完全通过，请检查', 'warn');
}

function renderVerifyTable(data) {
  const rows = (data.details || []).map((d) => {
    const c = d.checks || {};
    const cls = c.matched && c.responseMatch && c.modelMatch && c.responseToolMatch ? 'ok-row' : 'bad-row';
    const replayAttr = d.clientRound !== null && d.clientRound !== undefined ? `data-replay-turn="${d.clientRound}"` : '';
    return `<tr class="${cls} ${replayAttr ? 'clickable-row' : ''}" ${replayAttr}>
      <td>${d.proxyIndex ?? '-'}</td>
      <td>${d.clientRound ?? '未匹配'}</td>
      <td>${Math.round((d.confidence || 0) * 100)}%</td>
      <td>${statusMark(c.userContentMatch)}</td>
      <td>${statusMark(c.responseMatch)}</td>
      <td>${statusMark(c.modelMatch)}</td>
      <td>${statusMark(c.responseToolMatch)}</td>
      <td>${c.thinkingInfo ? `${c.thinkingInfo.clientThinkingLength || 0}/${c.thinkingInfo.proxyReasoningLength || 0}` : '-'}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap mini-table"><table>
    <thead><tr><th>Proxy</th><th>Claude</th><th>Confidence</th><th>User</th><th>Response</th><th>Model</th><th>Tools</th><th>Thinking</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8">${emptyState('◇', '暂无验证详情')}</td></tr>`}</tbody>
  </table></div>`;
}

function bindVerifyReplayLinks() {
  $('verifyTable').querySelectorAll('[data-replay-turn]').forEach((row) => {
    row.addEventListener('click', () => {
      openReplayTurn(Number(row.dataset.replayTurn)).catch((err) => {
        showToast(err.message || '无法打开回放轮次', 'error', 3000);
      });
    });
  });
}

function statusMark(value) {
  if (value === true) return '<span class="mark ok">yes</span>';
  if (value === false) return '<span class="mark bad">no</span>';
  return '<span class="mark muted">-</span>';
}

/* ===== Replay debugger ===== */
function replayStatusText(status) {
  return { ok: '通过', warn: '警告', error: '失败' }[status] || '未知';
}

function replayStatusClass(status) {
  return status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : 'error';
}

function replayText(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function firstMismatchIndex(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if (left[i] !== right[i]) return i;
  }
  return left.length === right.length ? -1 : len;
}

function renderReplayMetrics(data) {
  const s = data.summary || {};
  renderMetrics($('replayMetrics'), [
    ['轮次', s.turns ?? 0, ''],
    ['代理请求', s.proxyRequests ?? 0, ''],
    ['匹配轮次', s.matchedTurns ?? 0, (s.matchedTurns || 0) ? 'ok' : 'warn'],
    ['正式问题', s.problemTurns ?? 0, s.problemTurns ? 'warn' : 'ok'],
    ['额外请求', s.extraProxyWarnings ?? 0, s.extraProxyWarnings ? 'warn' : 'ok'],
    ['注意项', s.attentionItems ?? 0, s.attentionItems ? 'warn' : 'ok'],
    ['失败', s.errorTurns ?? 0, s.errorTurns ? 'error' : 'ok'],
    ['trajectory 行', s.trajectoryLines ?? 0, s.trajectoryLines ? 'ok' : 'warn'],
  ]);
}

async function loadReplay(options = {}) {
  const data = await api(`/api/sessions/${currentSessionId()}/replay`);
  state.replay.data = data;
  state.replay.onlyProblems = Boolean($('replayOnlyProblems')?.checked);
  if (options.turnIndex !== undefined && options.turnIndex !== null) {
    state.replay.selected = { kind: 'turn', index: Number(options.turnIndex) };
  } else if (!state.replay.selected) {
    const firstProblem = data.turns.find((turn) => turn.status !== 'ok');
    state.replay.selected = firstProblem
      ? { kind: 'turn', index: firstProblem.turnIndex }
      : (data.turns[0] ? { kind: 'turn', index: data.turns[0].turnIndex } : null);
  }
  renderReplay();
  if (!options.quiet) showToast('轨迹回放已加载', 'success', 1800);
}

function renderReplay() {
  const data = state.replay.data;
  if (!data) {
    $('replayMetrics').innerHTML = '';
    $('replayTimeline').innerHTML = emptyState('◇', '还没有加载回放数据');
    $('replayDetail').innerHTML = emptyState('◇', '选择一个 Session 后点击“加载回放”');
    $('replayDiagnostics').innerHTML = emptyState('◇', '暂无诊断');
    return;
  }
  renderReplayMetrics(data);
  renderReplayTimeline(data);
  renderReplayDetail(data);
}

function renderReplayTimeline(data) {
  const onlyProblems = state.replay.onlyProblems;
  const turns = onlyProblems ? data.turns.filter((turn) => turn.status !== 'ok') : data.turns;
  const proxyOnly = data.proxyOnly || [];
  const rows = [];

  for (const turn of turns) {
    const selected = state.replay.selected?.kind === 'turn' && state.replay.selected.index === turn.turnIndex;
    const note = replayTurnNote(turn);
    rows.push(`
      <button class="replay-node ${replayStatusClass(turn.status)} ${selected ? 'active' : ''}" data-turn-index="${turn.turnIndex}">
        <span class="replay-node-main">
          <strong>#${turn.turnIndex}</strong>
          <span>${escapeHtml(replayStatusText(turn.status))}</span>
        </span>
        <span class="replay-node-sub">${escapeHtml(turn.proxy?.requestModel || turn.assistant?.modelId || 'model: -')}</span>
        <span class="replay-node-note">${escapeHtml(note)}</span>
      </button>
    `);
  }

  proxyOnly.forEach((item, index) => {
    const selected = state.replay.selected?.kind === 'proxyOnly' && state.replay.selected.index === index;
    const firstDiag = (item.diagnostics || [])[0] || {};
    const label = item.status === 'warn' ? '旁路' : '未匹配';
    rows.push(`
      <button class="replay-node ${replayStatusClass(item.status)} ${selected ? 'active' : ''}" data-proxy-only-index="${index}">
        <span class="replay-node-main">
          <strong>Proxy #${item.proxy?.seqIndex ?? '-'}</strong>
          <span>${escapeHtml(label)}</span>
        </span>
        <span class="replay-node-sub">${escapeHtml(item.proxy?.path || '')}</span>
        <span class="replay-node-note">${escapeHtml(firstDiag.message || '')}</span>
      </button>
    `);
  });

  $('replayTimeline').innerHTML = rows.join('') || emptyState('✓', onlyProblems ? '没有需要注意的轮次或额外请求' : '没有回放轮次');
  $('replayTimeline').querySelectorAll('[data-turn-index]').forEach((btn) => {
    btn.addEventListener('click', () => selectReplayTurn(Number(btn.dataset.turnIndex)));
  });
  $('replayTimeline').querySelectorAll('[data-proxy-only-index]').forEach((btn) => {
    btn.addEventListener('click', () => selectReplayProxyOnly(Number(btn.dataset.proxyOnlyIndex)));
  });
}

function replayTurnNote(turn) {
  const diagnostics = turn.diagnostics || [];
  const firstActionable = diagnostics.find((d) => d.level !== 'info');
  if (firstActionable) return firstActionable.message || '';
  if (turn.status === 'ok') {
    const hasUserContextDelta = diagnostics.some((d) => d.code === 'user_mismatch');
    return hasUserContextDelta ? '验证通过；User 仅有注入上下文差异' : '这一轮验证通过，结构完整';
  }
  return diagnostics[0]?.message || '';
}

function selectReplayTurn(turnIndex) {
  state.replay.selected = { kind: 'turn', index: Number(turnIndex) };
  renderReplay();
}

function selectReplayProxyOnly(index) {
  state.replay.selected = { kind: 'proxyOnly', index: Number(index) };
  renderReplay();
}

function renderReplayBlock(title, value, cls = '') {
  return `<section class="replay-block ${cls}">
    <h3>${escapeHtml(title)}</h3>
    <pre>${escapeHtml(replayText(value))}</pre>
  </section>`;
}

function renderReplayCompare(title, leftLabel, leftValue, rightLabel, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  const mismatch = firstMismatchIndex(left, right);
  const badge = mismatch === -1
    ? '<span class="mark ok">一致</span>'
    : `<span class="mark bad">首个差异 @ ${mismatch}</span>`;
  return `<section class="replay-block replay-compare-block">
    <h3>${escapeHtml(title)} ${badge}</h3>
    <div class="replay-compare">
      <div>
        <div class="replay-compare-title">${escapeHtml(leftLabel)}</div>
        <pre>${escapeHtml(replayText(left))}</pre>
      </div>
      <div>
        <div class="replay-compare-title">${escapeHtml(rightLabel)}</div>
        <pre>${escapeHtml(replayText(right))}</pre>
      </div>
    </div>
  </section>`;
}

function renderReplayTools(toolUses = []) {
  if (!toolUses.length) return renderReplayBlock('Tool Uses', '-');
  const rows = toolUses.map((tool, index) => `
    <div class="replay-tool">
      <div><span class="metric ok">#${index}</span> <strong>${escapeHtml(tool.name || '-')}</strong> <span class="hint inline">${escapeHtml(tool.id || '')}</span></div>
      <pre>${escapeHtml(JSON.stringify(tool.input || {}, null, 2))}</pre>
    </div>
  `).join('');
  return `<section class="replay-block"><h3>Tool Uses</h3>${rows}</section>`;
}

function renderReplayDiagnosticsList(diagnostics = []) {
  return diagnostics.map((item) => `
    <li class="${replayStatusClass(item.level === 'info' ? 'ok' : item.level)}">
      <strong>${escapeHtml(item.code || item.level)}</strong>
      <span>${escapeHtml(item.message || '')}</span>
    </li>
  `).join('');
}

function renderReplayDetail(data) {
  const selected = state.replay.selected;
  if (!selected) {
    $('replayDetailTitle').textContent = '选择一个轮次';
    $('replayDetailMeta').textContent = '';
    $('replayDetail').innerHTML = emptyState('◇', '没有可显示的回放轮次');
    $('replayDiagnostics').innerHTML = emptyState('◇', '暂无诊断');
    return;
  }

  if (selected.kind === 'proxyOnly') {
    const item = data.proxyOnly[selected.index];
    const titlePrefix = item?.status === 'warn' ? '旁路代理请求' : '未匹配代理请求';
    $('replayDetailTitle').textContent = `${titlePrefix} #${item?.proxy?.seqIndex ?? '-'}`;
    $('replayDetailMeta').textContent = item?.proxy?.url || '';
    $('replayDetail').innerHTML = `
      ${renderReplayBlock('Proxy Metadata', item?.proxy)}
      ${renderReplayBlock('Proxy User', item?.proxy?.userContent)}
      ${renderReplayBlock('Proxy Assistant', item?.proxy?.responseContent)}
      ${renderReplayBlock('Proxy Reasoning', item?.proxy?.responseReasoning)}
    `;
    $('replayDiagnostics').innerHTML = `<ul class="replay-diagnostic-list">${renderReplayDiagnosticsList(item?.diagnostics || [])}</ul>`;
    return;
  }

  const turn = data.turns.find((item) => item.turnIndex === selected.index) || data.turns[0];
  if (!turn) return;
  $('replayDetailTitle').textContent = `轮次 #${turn.turnIndex}`;
  $('replayDetailMeta').textContent = `Proxy #${turn.proxy?.seqIndex ?? '-'} · ${replayStatusText(turn.status)}`;

  const historyModel = turn.assistant?.modelId || '';
  const trajectoryModel = turn.trajectory?.assistantLine?.data?.model || turn.trajectory?.userLine?.data?.model || '';
  const modelSources = {
    requestModel: turn.proxy?.requestModel || '',
    responseModel: turn.proxy?.responseModel || '',
    historyModel,
    trajectoryModel,
  };
  $('replayDetail').innerHTML = `
    ${renderReplayCompare('Assistant 对比', 'Proxy response', turn.proxy?.responseContent || '', 'Claude History', turn.assistant?.content || '')}
    ${renderReplayBlock('User', turn.user?.content)}
    ${turn.user?.toolResults?.length ? renderReplayBlock('Tool Results', turn.user.toolResults) : ''}
    ${renderReplayBlock('Thinking', turn.assistant?.thinking)}
    ${renderReplayTools(turn.assistant?.toolUses || [])}
    ${renderReplayBlock('Model Sources', modelSources)}
    ${renderReplayBlock('Proxy Metadata', {
      path: turn.proxy?.path,
      status: turn.proxy?.status,
      duration: turn.proxy?.duration,
      tokens: tokenText(turn.proxy?.usage),
      hasSystemPrompt: turn.proxy?.hasSystemPrompt,
    })}
    ${renderReplayBlock('Trajectory Lines', turn.trajectory)}
  `;

  const checks = turn.verification?.checks || {};
  $('replayDiagnostics').innerHTML = `
    <ul class="replay-diagnostic-list">${renderReplayDiagnosticsList(turn.diagnostics || [])}</ul>
    <div class="replay-checks">
      ${metric('User', statusMarkText(checks.userContentMatch), checks.userContentMatch === false ? 'error' : 'ok')}
      ${metric('Response', statusMarkText(checks.responseMatch), checks.responseMatch === false ? 'error' : 'ok')}
      ${metric('Model', statusMarkText(checks.modelMatch), checks.modelMatch === false ? 'error' : 'ok')}
      ${metric('Tools', statusMarkText(checks.responseToolMatch), checks.responseToolMatch === false ? 'error' : 'ok')}
      ${metric('Confidence', turn.verification ? `${Math.round((turn.verification.confidence || 0) * 100)}%` : '-', turn.status === 'ok' ? 'ok' : 'warn')}
    </div>
    ${renderReplayBlock('Verification Detail', turn.verification || '-')}
  `;
}

function statusMarkText(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '-';
}

async function openReplayTurn(turnIndex) {
  document.querySelector('.tab[data-tab="workspaceD"]').click();
  if (!state.replay.data) {
    await loadReplay({ quiet: true, turnIndex });
  } else {
    selectReplayTurn(turnIndex);
  }
}

async function convert() {
  const body = {
    instance_id: $('instanceId').value.trim(),
    task_id: $('taskId').value.trim(),
    model: $('model').value,
    repo: $('repo').value.trim(),
    base_commit: $('baseCommit').value.trim(),
    language: $('language').value.trim(),
    problem_statement: $('problemStatement').value.trim(),
    summary_cot: $('summaryCot').value.trim(),
  };
  const data = await api(`/api/sessions/${currentSessionId()}/convert`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  renderQc(data.qc);
  $('deliveryPreview').textContent = `${JSON.stringify(data.qc, null, 2)}\n\n--- preview ---\n${data.preview}`;
  await refreshSession();
  if (data.qc.passed) showToast('SOP 生成并通过质检 ✦', 'success');
  else showToast('已生成，但质检未通过', 'warn');
}

async function loadTrajectory() {
  const text = await api(`/api/sessions/${currentSessionId()}/file?name=trajectory.jsonl`);
  $('deliveryPreview').textContent = text;
  $('deliveryPreview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('trajectory.jsonl 已加载', 'success');
}

function downloadFile(name) {
  window.location.href = `/api/sessions/${currentSessionId()}/download?name=${name}`;
}

function renderQc(qc) {
  renderMetrics($('qcMetrics'), [
    ['通过', qc.passed ? 'yes' : 'no', qc.passed ? 'ok' : 'error'],
    ['Errors', qc.errors.length, qc.errors.length ? 'error' : 'ok'],
    ['Warnings', qc.warnings.length, qc.warnings.length ? 'warn' : 'ok'],
  ]);
  $('qcDetails').innerHTML = `
    ${renderQcGroup('Errors', qc.errors, 'error')}
    ${renderQcGroup('Warnings', qc.warnings, 'warn')}
    ${renderQcGroup('Info', qc.info, 'info')}
  `;
}

function renderQcGroup(title, items = [], cls = '') {
  const rows = items.length
    ? items.map((item) => `<li>${escapeHtml(item)}<div class="qc-help">${escapeHtml(qcHelp(item))}</div></li>`).join('')
    : '<li>无</li>';
  return `<div class="qc-group ${cls}"><div class="qc-title">${title}</div><ul>${rows}</ul></div>`;
}

function qcHelp(item) {
  if (/empty cot/i.test(item)) return '重新采集或确认模型每轮 assistant 都输出 thinking/cot。';
  if (/model/i.test(item)) return '在工作区 B 选择 SOP 允许的 claude-opus-4-6 或 claude-opus-4-8。';
  if (/tool uses/i.test(item)) return '正式任务需要包含读文件、编辑文件、运行命令等工具调用。';
  if (/summary_cot/i.test(item) || /Full multi-round cot/i.test(item)) return '缩短 Summary CoT，确保完整 CoT 总长度更长。';
  if (/secret/i.test(item)) return '导出前检查并脱敏 API key、token、cookie、私钥等内容。';
  return '';
}

function openNewSessionModal() {
  $('newSessionModal').classList.remove('hidden');
  $('newSessionName').value = '';
  $('newSessionName').focus();
}
async function confirmNewSession() {
  const name = $('newSessionName').value.trim();
  await createSession(name);
  $('newSessionModal').classList.add('hidden');
  await refreshStatus();
}

function openHistoryPicker() { $('historyPicker').classList.remove('hidden'); }
function closeHistoryPicker() { $('historyPicker').classList.add('hidden'); }

async function scanHistories() {
  const data = await api('/api/claude-histories');
  const body = $('historyPickerBody');
  if (!data.histories.length) {
    body.innerHTML = emptyState('⌕', '没有找到 Claude Code 历史');
  } else {
    body.innerHTML = data.histories.slice(0, 20).map((h) => `
      <button class="history-item" data-path="${escapeHtml(h.path)}">
        <span>${escapeHtml(h.project)}</span>
        <small>${escapeHtml(localTime(h.mtime))} · ${formatBytes(h.size)}</small>
      </button>
    `).join('');
    body.querySelectorAll('.history-item').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('导入将覆盖当前 Session 的历史文件，继续吗？')) return;
        await api(`/api/sessions/${currentSessionId()}/import`, {
          method: 'POST',
          body: JSON.stringify({ historyPath: btn.dataset.path }),
        });
        closeHistoryPicker();
        await refreshStatus();
        await loadIntercepts();
        showToast('历史已导入，正在自动验证…', 'success');
        try { await runVerify(); } catch {}
      });
    });
  }
  openHistoryPicker();
}

function metadataStorageKey() {
  return `trajectoryWorkbenchMeta:${currentSessionId()}`;
}

function saveMetadataDraft() {
  if (!$('sessionSelect').value) return;
  const data = {
    instanceId: $('instanceId').value,
    taskId: $('taskId').value,
    model: $('model').value,
    repo: $('repo').value,
    baseCommit: $('baseCommit').value,
    language: $('language').value,
    problemStatement: $('problemStatement').value,
    summaryCot: $('summaryCot').value,
  };
  localStorage.setItem(metadataStorageKey(), JSON.stringify(data));
}

function loadMetadataDraft() {
  if (!$('sessionSelect').value) return;
  const raw = localStorage.getItem(metadataStorageKey());
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    $('instanceId').value = data.instanceId || '';
    $('taskId').value = data.taskId || '';
    $('model').value = data.model || '';
    $('repo').value = data.repo || '';
    $('baseCommit').value = data.baseCommit || '';
    $('language').value = data.language || '';
    $('problemStatement').value = data.problemStatement || '';
    $('summaryCot').value = data.summaryCot || '';
  } catch {}
}

/* ===== Theme ===== */
const DEFAULT_THEME = {
  wallpaper: '/pic/国服一周年贺图.jpg',
  panelOpacity: 90,
  wallpaperOpacity: 100,
  brightness: 100,
  blur: 0,
};

function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem('workbenchTheme'));
    // 兼容旧版没有 wallpaperOpacity 的存档
    if (saved && saved.wallpaperOpacity === undefined) saved.wallpaperOpacity = DEFAULT_THEME.wallpaperOpacity;
    return saved || { ...DEFAULT_THEME };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

function saveTheme(t) {
  localStorage.setItem('workbenchTheme', JSON.stringify(t));
}

function applyTheme(t) {
  const body = document.body;
  body.style.setProperty('--wallpaper-url', `url('${t.wallpaper}')`);
  body.style.setProperty('--panel-opacity', t.panelOpacity / 100);
  body.style.setProperty('--wallpaper-opacity', t.wallpaperOpacity / 100);
  body.style.setProperty('--wallpaper-brightness', t.brightness / 100);
  body.style.setProperty('--wallpaper-blur', `${t.blur}px`);

  // 更新滑条
  ['panelOpacity', 'wallpaperOpacity', 'wallpaperBrightness', 'wallpaperBlur'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      const key = id === 'panelOpacity' ? 'panelOpacity'
        : id === 'wallpaperOpacity' ? 'wallpaperOpacity'
        : id === 'wallpaperBrightness' ? 'brightness' : 'blur';
      el.value = t[key];
    }
  });
  $('opacityVal').textContent = `${t.panelOpacity}%`;
  $('wallpaperOpacityVal').textContent = `${t.wallpaperOpacity}%`;
  $('brightnessVal').textContent = `${t.brightness}%`;
  $('blurVal').textContent = `${t.blur}px`;
  updateWallpaperName();
}

function updateWallpaperName() {
  const t = loadTheme();
  const el = $('wpCurrentName');
  if (el) {
    const name = (t.wallpaper || '').split('/').pop() || '默认';
    el.textContent = '当前：' + name;
  }
}

async function pickWallpaper() {
  const input = $('wallpaperFileInput');
  input.value = '';
  input.click();
}

async function handleWallpaperFile() {
  const input = $('wallpaperFileInput');
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('wallpaper', file);
  try {
    const resp = await fetch('/api/wallpapers/upload', { method: 'POST', body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '上传失败');
    const t = loadTheme();
    t.wallpaper = data.path;
    saveTheme(t);
    applyTheme(t);
    updateWallpaperName();
    showToast('壁纸已更换 ✦', 'success');
  } catch (err) {
    showToast('更换失败: ' + (err.message || '未知'), 'error');
  }
  input.value = '';
}

async function toggleThemePopover() {
  const popover = $('themePopover');
  popover.classList.toggle('hidden');
  if (!popover.classList.contains('hidden')) {
    updateWallpaperName();
    let picDir = state.picDir;
    if (!picDir) {
      // 刚启动还没缓存，主动请求一次
      try {
        const status = await api('/api/status');
        picDir = (status.certs && status.certs.picDir) ? status.certs.picDir : '';
        state.picDir = picDir;
      } catch { picDir = ''; }
    }
    $('wpHint').textContent = picDir ? '壁纸路径：' + displayPath(picDir) : '';
  }
}

function closeThemePopover(e) {
  const wrapper = document.querySelector('.theme-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    $('themePopover').classList.add('hidden');
  }
}

function resetTheme() {
  const t = { ...DEFAULT_THEME };
  saveTheme(t);
  applyTheme(t);
}

function initTheme() {
  const t = loadTheme();
  applyTheme(t);

  $('themeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThemePopover();
  });

  $('pickWallpaperBtn').addEventListener('click', pickWallpaper);
  $('wallpaperFileInput').addEventListener('change', handleWallpaperFile);

  // 滑块事件
  [
    { id: 'panelOpacity', key: 'panelOpacity', valId: 'opacityVal', fmt: (v) => `${v}%`, cssVar: '--panel-opacity', scale: 100, suffix: '' },
    { id: 'wallpaperOpacity', key: 'wallpaperOpacity', valId: 'wallpaperOpacityVal', fmt: (v) => `${v}%`, cssVar: '--wallpaper-opacity', scale: 100, suffix: '' },
    { id: 'wallpaperBrightness', key: 'brightness', valId: 'brightnessVal', fmt: (v) => `${v}%`, cssVar: '--wallpaper-brightness', scale: 100, suffix: '' },
    { id: 'wallpaperBlur', key: 'blur', valId: 'blurVal', fmt: (v) => `${v}px`, cssVar: '--wallpaper-blur', scale: 1, suffix: 'px' },
  ].forEach(({ id, key, valId, fmt, cssVar, scale, suffix }) => {
    const slider = document.getElementById(id);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const val = Number(slider.value);
      const el = document.getElementById(valId);
      if (el) el.textContent = fmt(val);
      document.body.style.setProperty(cssVar, (val / scale) + suffix);
    });
    slider.addEventListener('change', () => {
      const th = loadTheme();
      th[key] = Number(slider.value);
      saveTheme(th);
    });
  });

  $('themeReset').addEventListener('click', resetTheme);

  document.addEventListener('click', closeThemePopover);
}

function openModal() {
  $('detailModal').classList.remove('hidden');
  $('detailModal').setAttribute('aria-hidden', 'false');
}

function closeModal() {
  if ($('detailModal').contains(document.activeElement)) document.activeElement.blur();
  $('detailModal').classList.add('hidden');
  $('detailModal').setAttribute('aria-hidden', 'true');
}

/* ===== Particles ===== */
function initParticles() {
  const layer = $('particleLayer');
  if (!layer) return;
  const count = window.innerWidth < 1000 ? 10 : 18;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 6 + Math.random() * 10;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (8 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    if (Math.random() > 0.5) {
      p.style.background = 'radial-gradient(circle, rgba(91,155,213,0.5), rgba(91,155,213,0))';
    }
    layer.appendChild(p);
  }
}

function bind() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      button.classList.add('active');
      $(button.dataset.tab).classList.add('active');
      if (button.dataset.tab === 'workspaceC' && !state.terminal.ready) {
        initTerminal();
      }
      if (button.dataset.tab === 'workspaceD' && !state.replay.data) {
        loadReplay({ quiet: true }).catch((err) => {
          showToast(err.message || '回放加载失败', 'error', 3000);
        });
      }
    });
  });
  // 折叠面板切换
  document.querySelectorAll('.collapse-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const target = document.getElementById(toggle.dataset.target);
      if (target) target.classList.toggle('collapsed');
    });
  });
  $('sessionSelect').addEventListener('change', refreshSession);
  $('createSession').addEventListener('click', wrap(() => createSession(), $('createSession')));
  $('confirmNewSession').addEventListener('click', wrap(confirmNewSession, $('confirmNewSession')));
  $('newSessionName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNewSession();
  });
  $('renameSession').addEventListener('click', wrap(renameSession, $('renameSession')));
  $('clearSession').addEventListener('click', wrap(clearSession, $('clearSession')));
  $('deleteSession').addEventListener('click', wrap(deleteSession, $('deleteSession')));
  $('openSessionDir').addEventListener('click', wrap(openSessionDir, $('openSessionDir')));
  $('importSession').addEventListener('click', wrap(importSession, $('importSession')));
  $('scanHistories').addEventListener('click', wrap(scanHistories, $('scanHistories')));
  $('clearHistory').addEventListener('click', wrap(clearHistory, $('clearHistory')));
  $('copyBashCommand').addEventListener('click', wrap(copyBashCommand, $('copyBashCommand')));
  $('copyPSCommand').addEventListener('click', wrap(copyPSCommand, $('copyPSCommand')));
  $('copyCMDCommand').addEventListener('click', wrap(copyCMDCommand, $('copyCMDCommand')));
  $('copyBashOnly').addEventListener('click', wrap(copyBashOnly, $('copyBashOnly')));
  $('copyPSOnly').addEventListener('click', wrap(copyPSOnly, $('copyPSOnly')));
  $('copyCMDOnly').addEventListener('click', wrap(copyCMDOnly, $('copyCMDOnly')));
  $('startProxy').addEventListener('click', wrap(startProxyWrapped, $('startProxy')));
  $('stopProxy').addEventListener('click', wrap(stopProxy, $('stopProxy')));
  $('shutdownWorkbench').addEventListener('click', shutdownWorkbench);
  $('loadIntercepts').addEventListener('click', wrap(loadIntercepts, $('loadIntercepts')));
  // Sortable table headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir = 'asc';
      }
      // Update header markers
      document.querySelectorAll('th.sortable').forEach((h) => {
        h.classList.remove('sorted');
        const label = h.textContent.replace(/ [▴▾]$/, '');
        h.textContent = label;
      });
      th.classList.add('sorted');
      th.textContent = th.textContent.replace(/ [▴▾]$/, '') + (state.sortDir === 'asc' ? ' ▴' : ' ▾');
      // Reload with sort
      loadIntercepts().catch(() => {});
    });
  });
  $('runVerify').addEventListener('click', wrap(runVerify, $('runVerify')));
  $('loadReplay').addEventListener('click', wrap(loadReplay, $('loadReplay')));
  $('replayOnlyProblems').addEventListener('change', () => {
    state.replay.onlyProblems = $('replayOnlyProblems').checked;
    renderReplay();
  });
  $('convert').addEventListener('click', wrap(convert, $('convert')));
  $('loadTrajectory').addEventListener('click', wrap(loadTrajectory, $('loadTrajectory')));
  $('downloadTrajectory').addEventListener('click', () => { downloadFile('trajectory.jsonl'); showToast('下载中', 'info'); });
  $('downloadInstance').addEventListener('click', () => { downloadFile('instance.json'); showToast('下载中', 'info'); });
  $('copyBaseCommitCmd').addEventListener('click', () => {
    const cmd = $('baseCommitCmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('命令已复制', 'info', 2000)).catch(() => showToast('复制失败', 'error'));
  });
  $('terminalRestart').addEventListener('click', restartTerminal);
  $('terminalReconnect').addEventListener('click', restartTerminal);
  document.querySelectorAll('.shell-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTerminalShell(btn.dataset.shell));
  });
  bindCwdEvents();
  $('closeModal').addEventListener('click', closeModal);
  $('detailModal').addEventListener('click', (event) => {
    if (event.target.id === 'detailModal') closeModal();
  });
  $('closeHistoryPicker').addEventListener('click', closeHistoryPicker);
  $('historyPicker').addEventListener('click', (event) => {
    if (event.target.id === 'historyPicker') closeHistoryPicker();
  });
  ['instanceId', 'taskId', 'model', 'repo', 'baseCommit', 'language', 'problemStatement', 'summaryCot'].forEach((id) => {
    $(id).addEventListener('input', saveMetadataDraft);
    $(id).addEventListener('change', saveMetadataDraft);
  });
}

function wrap(fn, button) {
  return async () => {
    if (button && button.classList.contains('is-loading')) return;
    if (button) button.classList.add('is-loading');
    try {
      await fn();
    } catch (err) {
      showToast(err.message || '操作失败', 'error', 4000);
    } finally {
      if (button) button.classList.remove('is-loading');
    }
  };
}

async function initPortrait() {
  const portrait = $('characterPortrait');
  if (!portrait) return;
  try {
    const data = await api('/api/wallpapers');
    if (data.wallpapers && data.wallpapers.length) {
      const pick = data.wallpapers[Math.floor(Math.random() * data.wallpapers.length)];
      // 预加载再切换，避免闪白
      const img = new Image();
      img.onload = () => {
        portrait.style.opacity = '0';
        setTimeout(() => {
          portrait.src = pick.path;
          portrait.style.opacity = '1';
        }, 180);
      };
      img.src = pick.path;
    }
  } catch {
    // 加载失败，保持默认图片
  }
}

// 日志自动滚底
function initLogScroll() {
  const el = $('logs');
  state.logAutoScroll = true;
  el.addEventListener('scroll', () => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    state.logAutoScroll = atBottom;
  });
}

// ── Terminal (Workspace C) ─────────────────────────────

function getTerminalShell() {
  // Return user-selected shell, or empty to let server auto-detect
  return state.terminal.shell || '';
}

function getTerminalShellHint() {
  const shell = getTerminalShell();
  if (shell) {
    if (shell === 'bash' || shell.includes('bash')) return 'Git Bash';
    if (shell.includes('powershell')) return 'PowerShell';
    if (shell.includes('cmd')) return 'CMD';
  }
  return '';
}

function switchTerminalShell(shell) {
  state.terminal.shell = shell;
  // Update active button state
  document.querySelectorAll('.shell-btn').forEach((btn) => {
    btn.classList.toggle('active-shell', btn.dataset.shell === shell);
  });
  restartTerminal();
}

// ── Working directory ──────────────────────────────────

const CWD_STORAGE_KEY = 'workbench-terminal-cwd';

function getSavedCwd() {
  try {
    const saved = localStorage.getItem(CWD_STORAGE_KEY);
    if (saved) return saved;
  } catch {}
  return '';
}

function setSavedCwd(cwd) {
  try { localStorage.setItem(CWD_STORAGE_KEY, cwd); } catch {}
}

function applyCwd(newCwd) {
  const t = state.terminal;
  const trimmed = String(newCwd || '').trim();
  if (trimmed && trimmed !== t.cwd) {
    t.cwd = trimmed;
    setSavedCwd(trimmed);
    if (t.ready || t.connecting) restartTerminal();
  }
}

function loadCwdUI() {
  const t = state.terminal;
  if (!t.cwd) t.cwd = getSavedCwd();
  const input = document.getElementById('terminalCwd');
  if (input) input.value = t.cwd || '';
}

function bindCwdEvents() {
  const input = document.getElementById('terminalCwd');
  const browseBtn = document.getElementById('terminalCwdBrowse');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCwd(input.value);
      input.blur();
    }
  });
  // Save on blur if changed
  input.addEventListener('blur', () => {
    const val = String(input.value || '').trim();
    if (val && val !== state.terminal.cwd) applyCwd(val);
  });

  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      // Open the current cwd in OS file explorer; user copies path from there
      const cwd = state.terminal.cwd || '';
      try {
        await api('/api/open-dir', { method: 'POST', body: JSON.stringify({ path: cwd }) });
        showToast('复制路径后粘贴到左侧输入框，按回车生效', 'info', 3000);
      } catch {
        showToast('无法打开目录', 'error', 2000);
      }
    });
  }
}

let terminalResizeObserver = null;

function restartTerminal() {
  const t = state.terminal;
  // Detach stale event handlers first so they can't corrupt the new connection
  const oldWs = t.ws;
  t.ws = null;
  t.connecting = false;
  if (oldWs) {
    oldWs.onclose = null;
    oldWs.onmessage = null;
    oldWs.onopen = null;
    oldWs.onerror = null;
    try { oldWs.close(); } catch {}
  }
  if (terminalResizeObserver) {
    terminalResizeObserver.disconnect();
    terminalResizeObserver = null;
  }
  if (t.term) {
    try { t.term.dispose(); } catch {}
    t.term = null;
  }
  t.ready = false;
  t.fit = null;
  initTerminal();
}

function initTerminal() {
  const t = state.terminal;
  if (t.ready) return;
  if (t.term) return; // already initializing

  // Load persisted cwd
  loadCwdUI();

  // Set default shell if not yet chosen
  if (!t.shell) {
    const plat = navigator.platform || '';
    t.shell = plat.startsWith('Win') ? 'bash' : 'bash';
  }
  // Update button states
  document.querySelectorAll('.shell-btn').forEach((btn) => {
    btn.classList.toggle('active-shell', btn.dataset.shell === t.shell);
  });

  const container = document.getElementById('terminalContainer');
  if (!container) return;

  const hint = document.getElementById('terminalShellHint');
  if (hint) hint.textContent = getTerminalShellHint();

  const term = new Terminal({
    cursorBlink: true,
    disableStdin: false,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    scrollback: 3000,
    fastScrollModifier: 'alt',
    smoothScrollDuration: 0,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  t.fit = fitAddon;

  // WebGL renderer: GPU-accelerated, fixes IME composition, handles large output
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    term.loadAddon(webglAddon);
  } catch {
    // WebGL unavailable — fall back to DOM renderer
  }

  t.term = term;

  term.open(container);

  // ── Keyboard: Ctrl+C (SIGINT), Ctrl+V (paste) ──
  let pasteGate = false;
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+C: if no selection, send SIGINT
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'c') {
      if (!term.hasSelection()) {
        if (t.ws && t.ws.readyState === 1) t.ws.send('\x03');
        return false;
      }
    }
    // Ctrl+V: paste (terminal sends literal ^V otherwise)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'v') {
      pasteGate = true;
      navigator.clipboard.readText().then((text) => {
        if (t.ws && t.ws.readyState === 1) t.ws.send(text);
      }).catch(() => {});
      setTimeout(() => { pasteGate = false; }, 100);
      return false;
    }
    return true;
  });

  // Gate: block the browser paste event right after our manual Ctrl+V,
  // otherwise xterm.js pastes a second time
  term.textarea.addEventListener('paste', (e) => {
    if (pasteGate) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Focus immediately so the user can type right away
  term.focus();
  // Re-focus on click in case it loses focus
  container.addEventListener('click', () => term.focus(), { once: false });

  // ResizeObserver keeps terminal sized to container
  terminalResizeObserver = new ResizeObserver(() => {
    try { fitAddon.fit(); } catch {}
  });
  terminalResizeObserver.observe(container);

  // Fit first, then connect with real dimensions so PTY matches display
  // Use rAF to let the browser finish layout before measuring
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
      connectTerminalWs(term, fitAddon);
    });
  });
}

function connectTerminalWs(term, fitAddon) {
  const t = state.terminal;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Fit has already been called, so term.cols/rows reflect actual display size
  const cols = term.cols;
  const rows = term.rows;
  const shell = getTerminalShell();
  const cwd = state.terminal.cwd || '';
  const url = `${proto}//${location.host}/api/terminal?cols=${cols}&rows=${rows}&shell=${encodeURIComponent(shell)}&cwd=${encodeURIComponent(cwd)}`;

  const ws = new WebSocket(url);
  t.ws = ws;
  t.connecting = true;

  const reconnectBtn = document.getElementById('terminalReconnect');
  const hint = document.getElementById('terminalShellHint');

  ws.onopen = () => {
    if (t.ws !== ws) return; // stale
    t.ready = true;
    t.connecting = false;
    t.currentShell = t.shell; // track which shell is connected
    if (reconnectBtn) reconnectBtn.style.display = 'none';
    if (hint) { hint.textContent = '● 已连接'; hint.className = 'hint inline ok'; }
    // Immediately sync PTY size to actual terminal dimensions
    try { fitAddon.fit(); } catch {}
    ws.send('\x00' + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    term.focus();
  };

  ws.onmessage = (evt) => {
    if (t.ws !== ws) return; // stale
    term.write(evt.data);
  };

  ws.onclose = () => {
    if (t.ws !== ws) return; // stale — prevent corrupting new connection
    t.ready = false;
    t.connecting = false;
    t.ws = null;
    if (reconnectBtn) reconnectBtn.style.display = '';
    if (hint) { hint.textContent = '○ 已断开'; hint.className = 'hint inline bad'; }
    term.write('\r\n\x1b[33m[连接断开，点击"重连"按钮]\x1b[0m\r\n');
  };

  ws.onerror = () => {
    // onclose fires after this
  };

  term.onData((data) => {
    if (t.ws && t.ws.readyState === 1) {
      t.ws.send(data);
    }
  });

  term.onResize(({ cols, rows }) => {
    if (t.ws && t.ws.readyState === 1) {
      // \x00 prefix marks control messages so the server won't pipe them to shell stdin
      t.ws.send('\x00' + JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

bind();
initParticles();
initTheme();
initPortrait();
initLogScroll();
refreshStatus().then(() => {
  if (!state.sessions.length) openNewSessionModal();
}).catch((err) => showToast(err.message || '初始化失败', 'error', 4000));
state.statusTimer = setInterval(() => refreshStatus().catch(() => {}), 2500);
