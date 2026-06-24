// termi remote backend — WEB-APP mode.
//
// Serves the REAL termi renderer (src/) to a browser and provides a Node backend
// (pty / fs / git / clipboard) over a WebSocket. The browser loads a tiny shim
// (public/termi-bridge.js) that re-implements `window.termi` on top of this socket,
// so the unchanged renderer.js runs verbatim in any browser. Loaded LAZILY (only
// when the user opens the "door") so it adds zero overhead to normal desktop use.
//
// Each browser client runs its own renderer instance -> its own layout/pane ids ->
// its own ptys spawned HERE on the computer (a parallel session; commands run on the
// PC, not in the browser). A client's ptys are killed when its socket closes.
//
// Security (token + PIN): QR encodes https://<tunnel>/#t=<token> (token in the URL
// fragment, never in logs); the phone then types the PIN shown on the desktop; on
// success we set a signed HttpOnly session cookie; the WS upgrade requires it.

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const pty = require('node-pty');
const simpleGit = require('simple-git');
const tunnel = require('./tunnel');

let electronClipboard = null;
try { electronClipboard = require('electron').clipboard; } catch { /* not in electron (tests) */ }

const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECT_DIR = path.join(__dirname, '..');           // serves src/ and node_modules/
const SRC_DIR = path.join(PROJECT_DIR, 'src');
const NODE_MODULES = path.join(PROJECT_DIR, 'node_modules');

const MAX_LOGIN_ATTEMPTS = 8;
const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.COMSPEC && /powershell/i.test(process.env.COMSPEC) ? process.env.COMSPEC : 'powershell.exe')
  : (process.env.SHELL || 'bash');

// only these node_modules subtrees may be served (the app's front-end deps)
const NM_WHITELIST = ['@xterm', '@vscode', 'monaco-editor', 'marked'];

let state = null;

// ---------------- helpers ----------------

function randToken() { return crypto.randomBytes(24).toString('base64url'); }
function randPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function sign(v, s) { return crypto.createHmac('sha256', s).update(v).digest('base64url'); }
function makeSessionCookie(s) { const b = 'ok.' + Date.now(); return b + '.' + sign(b, s); }
function verifySessionCookie(raw, s) {
  if (!raw) return false;
  const p = String(raw).split('.');
  if (p.length !== 3) return false;
  try { return crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(sign(p[0] + '.' + p[1], s))); }
  catch { return false; }
}
function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.wasm': 'application/wasm',
};
function mime(f) { return MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'; }

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
// Serve the real src/index.html with the web bridge + mobile CSS injected. The
// original file on disk is never modified — injection happens in memory per request.
function serveIndexInjected(res) {
  fs.readFile(path.join(SRC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    html = html.replace(
      '<script src="renderer.js"></script>',
      '<script src="/web/termi-bridge.js"></script>\n  <script src="renderer.js"></script>'
    );
    html = html.replace('</head>', '  <link rel="stylesheet" href="/web/mobile.css" />\n</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
}

// Resolve a request path under a root, refusing path traversal.
function safeJoin(root, reqPath) {
  const p = path.normalize(path.join(root, decodeURIComponent(reqPath)));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
}

// A fresh trycloudflare subdomain isn't DNS-resolvable for a few seconds after the
// tunnel reports its URL. Poll the public URL until it actually answers, so we never
// show a QR that resolves to "can't find the server" on the phone.
function waitReachable(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + (timeoutMs || 25000);
    const attempt = () => {
      const req = https.get(url, { timeout: 5000 }, (res) => { res.resume(); resolve(true); });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 1500); };
    attempt();
  });
}

function doOp(fn) {
  return Promise.resolve().then(fn).then((v) => ({ ok: true, value: v }))
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
}

// recursive delete that survives Windows read-only / OneDrive placeholders
async function rmrf(target) {
  let st;
  try { st = await fsp.lstat(target); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try { await fsp.chmod(target, 0o666); } catch { /* */ }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let kids = []; try { kids = await fsp.readdir(target); } catch { /* */ }
    for (const k of kids) await rmrf(path.join(target, k));
    await fsp.rmdir(target);
  } else { await fsp.unlink(target); }
}

async function listDir(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const mapped = await Promise.all(ents.map(async (d) => {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (!isDir && !d.isFile()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { /* */ } }
      return { name: d.name, path: full, isDir };
    }));
    return mapped.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  } catch { return []; }
}

// ---------------- per-client RPC ----------------

async function handleRpc(client, op, args) {
  const a = args || {};
  switch (op) {
    // ----- pty (this client's own sessions) -----
    case 'spawn': {
      if (!state.control) return;
      if (client.ptys.has(a.id)) return;
      let cwd = a.cwd;
      try { if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir(); } catch { cwd = os.homedir(); }
      const proc = pty.spawn(DEFAULT_SHELL, [], { name: 'xterm-color', cols: a.cols || 80, rows: a.rows || 24, cwd, env: process.env });
      client.ptys.set(a.id, proc);
      proc.onData((data) => { if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ event: 'pty:data', id: a.id, data })); });
      proc.onExit(({ exitCode }) => { client.ptys.delete(a.id); if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ event: 'pty:exit', id: a.id, exitCode })); });
      return;
    }
    case 'write': { if (!state.control) return; const p = client.ptys.get(a.id); if (p) p.write(a.data); return; }
    case 'resize': { const p = client.ptys.get(a.id); if (p && a.cols > 0 && a.rows > 0) { try { p.resize(a.cols, a.rows); } catch { /* */ } } return; }
    case 'kill': { const p = client.ptys.get(a.id); if (p) { try { p.kill(); } catch { /* */ } client.ptys.delete(a.id); } return; }

    // ----- filesystem -----
    case 'home': return os.homedir();
    case 'listDir': return listDir(a.dir);
    case 'readFile': return doOp(() => fsp.readFile(a.file, 'utf8'));
    case 'writeFile': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => fsp.writeFile(a.file, a.data, 'utf8'));
    case 'mkdir': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => fsp.mkdir(path.join(a.parent, a.name)));
    case 'createFile': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => fsp.writeFile(path.join(a.parent, a.name), '', { flag: 'wx' }));
    case 'renamePath': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => fsp.rename(a.target, path.join(path.dirname(a.target), a.newName)));
    case 'deletePath': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => rmrf(a.target));
    case 'movePath': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(async () => {
      const target = path.join(a.destDir, path.basename(a.src));
      if (target === a.src) return;
      let exists = false; try { await fsp.access(target); exists = true; } catch { /* */ }
      if (exists) throw new Error('Υπάρχει ήδη στοιχείο με αυτό το όνομα στον προορισμό');
      await fsp.rename(a.src, target);
    });
    case 'watchDir': watchForClient(client, a.dir); return;

    // ----- git -----
    case 'gitStatus': return doOp(async () => {
      const git = simpleGit(a.dir);
      if (!(await git.checkIsRepo())) return { isRepo: false };
      const top = (await git.revparse(['--show-toplevel'])).trim();
      const s = await git.status();
      return { isRepo: true, root: top, branch: s.current, ahead: s.ahead, behind: s.behind,
        files: s.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir })) };
    });
    case 'gitCommit': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(async () => { const g = simpleGit(a.dir); await g.add(['-A']); return g.commit(a.message); });
    case 'gitPush': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => simpleGit(a.dir).push());
    case 'gitPull': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => simpleGit(a.dir).pull());
    case 'gitInit': if (!state.control) return { ok: false, error: 'read-only' }; return doOp(() => simpleGit(a.dir).init());

    // ----- clipboard -----
    case 'clipboardRead': return electronClipboard ? electronClipboard.readText() : '';
    case 'clipboardWrite': if (electronClipboard) electronClipboard.writeText(a.text || ''); return;

    default: return;
  }
}

function watchForClient(client, dir) {
  if (dir === client.watchDir) return;
  if (client.watcher) { try { client.watcher.close(); } catch { /* */ } client.watcher = null; }
  client.watchDir = dir || null;
  if (!dir) return;
  try {
    client.watcher = fs.watch(dir, { recursive: true }, () => {
      clearTimeout(client.watchTimer);
      client.watchTimer = setTimeout(() => { if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ event: 'fs:changed' })); }, 250);
    });
    client.watcher.on('error', () => { try { client.watcher.close(); } catch { /* */ } client.watcher = null; });
  } catch { /* */ }
}

function cleanupClient(client) {
  for (const p of client.ptys.values()) { try { p.kill(); } catch { /* */ } }
  client.ptys.clear();
  if (client.watcher) { try { client.watcher.close(); } catch { /* */ } client.watcher = null; }
  state && state.clients.delete(client);
}

// ---------------- open / close ----------------

// ctx: { userDataDir, controlEnabled, onLog?, onProgress? }
async function open(ctx) {
  if (state) return status();

  const token = randToken();
  // ctx.pin lets a caller (e.g. the CLI) pin a fixed code instead of a fresh random one.
  const pin = (ctx.pin != null && String(ctx.pin)) || randPin();
  const secret = crypto.randomBytes(32);
  state = {
    token, pin, secret, control: ctx.controlEnabled !== false,
    clients: new Set(), loginAttempts: 0,
    server: null, wss: null, tunnel: null, port: 0, url: '',
  };

  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;

    // web entry = the REAL src/index.html with 2 tags injected (bridge + mobile css)
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveIndexInjected(res);
    if (req.method === 'GET' && p === '/web/termi-bridge.js') return sendFile(res, path.join(PUBLIC_DIR, 'termi-bridge.js'));
    if (req.method === 'GET' && p === '/web/mobile.css') return sendFile(res, path.join(PUBLIC_DIR, 'mobile.css'));

    // the REAL app code, served verbatim & read-only (relative paths resolve as-is)
    if (req.method === 'GET' && p === '/renderer.js') return sendFile(res, path.join(SRC_DIR, 'renderer.js'));
    if (req.method === 'GET' && p === '/styles.css') return sendFile(res, path.join(SRC_DIR, 'styles.css'));
    if (req.method === 'GET' && p === '/remote-client.js') return sendFile(res, path.join(SRC_DIR, 'remote-client.js'));
    if (req.method === 'GET' && p.startsWith('/node_modules/')) {
      const rel = p.slice('/node_modules/'.length);
      if (!NM_WHITELIST.some((w) => rel === w || rel.startsWith(w + '/'))) { res.writeHead(403); return res.end('no'); }
      const f = safeJoin(NODE_MODULES, rel);
      return f ? sendFile(res, f) : (res.writeHead(403), res.end('no'));
    }

    // login
    if (req.method === 'POST' && p === '/api/login') {
      if (state.loginAttempts >= MAX_LOGIN_ATTEMPTS) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'locked' })); }
      const body = await readBody(req);
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch { /* */ }
      const tokOk = typeof parsed.token === 'string' && parsed.token.length === token.length && crypto.timingSafeEqual(Buffer.from(parsed.token), Buffer.from(token));
      const pinOk = typeof parsed.pin === 'string' && parsed.pin.length === pin.length && crypto.timingSafeEqual(Buffer.from(parsed.pin), Buffer.from(pin));
      if (tokOk && pinOk) {
        const cookie = makeSessionCookie(secret);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `termi_sess=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, control: state.control }));
      }
      state.loginAttempts++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'bad', left: MAX_LOGIN_ATTEMPTS - state.loginAttempts }));
    }

    res.writeHead(404); res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    if (!verifySessionCookie(parseCookies(req.headers.cookie).termi_sess, secret)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws) {
    const client = { ws, ptys: new Map(), watcher: null, watchDir: null, watchTimer: null };
    state.clients.add(client);
    ws.send(JSON.stringify({ event: 'ready', control: state.control }));
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let msg = {}; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { rid, op, args } = msg;
      if (!op) return;
      try {
        const value = await handleRpc(client, op, args);
        if (rid != null && ws.readyState === 1) ws.send(JSON.stringify({ rid, value }));
      } catch (err) {
        if (rid != null && ws.readyState === 1) ws.send(JSON.stringify({ rid, error: String((err && err.message) || err) }));
      }
    });
    ws.on('close', () => cleanupClient(client));
    ws.on('error', () => cleanupClient(client));
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  state.server = server; state.wss = wss; state.port = server.address().port;

  const bin = await tunnel.ensureBinary(ctx.userDataDir, ctx.onProgress);
  const t = await tunnel.start(bin, state.port, { onLog: ctx.onLog });
  state.tunnel = t; state.url = t.url;

  // wait until the public URL is genuinely reachable (DNS propagated + edge ready)
  if (ctx.onPhase) ctx.onPhase('waiting');
  await waitReachable(t.url, 25000);

  const fullUrl = `${t.url}/#t=${token}`;
  const qr = await QRCode.toDataURL(fullUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  return { open: true, url: t.url, fullUrl, pin, qr, control: state.control };
}

function status() {
  if (!state) return { open: false };
  return { open: true, url: state.url, fullUrl: `${state.url}/#t=${state.token}`, pin: state.pin, clients: state.clients.size, control: state.control };
}

function close() {
  if (!state) return { open: false };
  try { for (const c of [...state.clients]) cleanupClient(c); } catch { /* */ }
  try { state.wss && state.wss.close(); } catch { /* */ }
  try { state.server && state.server.close(); } catch { /* */ }
  try { state.tunnel && state.tunnel.stop(); } catch { /* */ }
  state = null;
  return { open: false };
}

function isOpen() { return !!state; }

module.exports = { open, close, status, isOpen };
