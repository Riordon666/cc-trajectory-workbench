const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

function attachTerminal(server, { host, port, rootDir, log = () => {}, maxTerminals = 4 } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const active = new Set();
  const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return reject(socket, 400); }
    if (url.pathname !== '/api/terminal') return socket.destroy();
    const origin = String(req.headers.origin || '');
    const requestHost = String(req.headers.host || '');
    if (!allowedOrigins.has(origin) || !allowedHosts.has(requestHost)) return reject(socket, 403);
    if (active.size >= maxTerminals) return reject(socket, 429);
    const shell = resolveShell(url.searchParams.get('shell') || '');
    const cwd = resolveCwd(url.searchParams.get('cwd') || '', rootDir);
    const cols = boundedInt(url.searchParams.get('cols'), 20, 400, 80);
    const rows = boundedInt(url.searchParams.get('rows'), 5, 200, 24);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let proc;
      try { proc = spawnPty(shell, cols, rows, cwd); }
      catch (error) { ws.close(1011, 'Terminal failed to start'); log(`Terminal start failed: ${error.message}`); return; }
      active.add(proc);
      log(`Terminal connected: ${path.basename(shell)} cwd=${cwd}`);
      const cleanup = () => { active.delete(proc); try { proc.kill(); } catch {} };
      proc.onData((data) => { if (ws.readyState === 1) ws.send(data); });
      proc.onExit(() => { active.delete(proc); if (ws.readyState === 1) ws.close(); });
      ws.on('message', (raw) => {
        const value = raw.toString();
        if (value.startsWith('\x00')) {
          try {
            const message = JSON.parse(value.slice(1));
            if (message.type === 'resize') proc.resize(boundedInt(message.cols, 20, 400, 80), boundedInt(message.rows, 5, 200, 24));
          } catch {}
          return;
        }
        try { proc.write(value); } catch {}
      });
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  });
  server.on('close', () => { for (const proc of active) try { proc.kill(); } catch {} active.clear(); });
  return { activeCount: () => active.size, allowedOrigins: [...allowedOrigins] };
}

function allowedRoots(rootDir) {
  return [rootDir, ...String(process.env.TERMINAL_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean)].map((value) => path.resolve(value));
}

function resolveCwd(input, rootDir) {
  const candidate = path.resolve(String(input || rootDir));
  const allowed = allowedRoots(rootDir).some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  return allowed && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : path.resolve(rootDir);
}

function findGitBash() {
  return ['C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\Git\\bin\\bash.exe', 'C:\\Git\\bin\\bash.exe'].find(fs.existsSync) || null;
}

function resolveShell(input) {
  const value = String(input || '').toLowerCase();
  if (process.platform !== 'win32') return value === 'bash' || !value ? (process.env.SHELL || 'bash') : process.env.SHELL || 'bash';
  if (!value || value === 'bash' || value.endsWith('bash.exe')) return findGitBash() || 'powershell.exe';
  if (value === 'powershell' || value === 'powershell.exe') return 'powershell.exe';
  if (value === 'pwsh' || value === 'pwsh.exe') return fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : 'powershell.exe';
  if (value === 'cmd' || value === 'cmd.exe') return 'cmd.exe';
  return 'powershell.exe';
}

function spawnPty(shell, cols, rows, cwd) {
  const lower = shell.toLowerCase();
  const args = lower.endsWith('bash.exe') || lower.endsWith('bash') ? ['--login', '-i'] : lower.includes('powershell') || lower.endsWith('pwsh.exe') ? ['-NoLogo'] : [];
  return pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' } });
}

function boundedInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function reject(socket, status) {
  const label = status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

module.exports = { allowedRoots, attachTerminal, boundedInt, resolveCwd, resolveShell };
