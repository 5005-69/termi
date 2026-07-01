// ============================================================
// termi — dynamic split-tree terminal manager (real terminals)
// ============================================================
//
// Layout = binary split tree (BSP). Drag a pane by its bar, drop on
// L/R/T/B of any pane to split it, center to swap. No fixed templates.
//
// Real terminals: each leaf owns a live xterm.js instance kept in `views`
// and connected to a node-pty process in the main process. On layout
// changes we MOVE the terminal's DOM node (never recreate it), so shell
// sessions survive every re-render.

const COLORS = ['#58a6ff', '#3fb950', '#f778ba', '#d29922', '#a371f7', '#ff7b72', '#39c5cf', '#db61a2'];
let colorIdx = 0;
let nextId = 1;

// Quirky codenames given to fresh terminals instead of "terminal 1, 2, 3…".
const TERM_NAMES = [
  'Cosmic Goat', 'Quantum Pickle', 'Ninja Toaster', 'Rogue Banana', 'Disco Kernel',
  'Funky Daemon', 'Sneaky Panda', 'Turbo Snail', 'Void Walker', 'Glitch Goblin',
  'Neon Llama', 'Pixel Wizard', 'Byte Goblin', 'Cyber Otter', 'Hyper Waffle',
  'Phantom Yak', 'Laser Llama', 'Atomic Newt', 'Velvet Hammer', 'Spicy Pixel',
  'Electric Sheep', 'Caffeine Daemon', 'Lone Wolf', 'Captain Kernel', 'Wandering Sudo',
  'Zombie Process', 'Segfault Sam', 'Null Pointer', 'Kernel Panic', 'Grumpy Cache',
  'Drunken Master', 'Salty Sailor', 'Mad Hatter', 'Soggy Biscuit', 'Rubber Duck',
];
function randomTermName() { return TERM_NAMES[Math.floor(Math.random() * TERM_NAMES.length)]; }

function makeLeaf(name) {
  const id = 'p' + (nextId++);
  const color = COLORS[colorIdx++ % COLORS.length];
  return { type: 'leaf', kind: 'terminal', id, name: name || randomTermName(), color, cwd: null };
}

function makeEditorLeaf(filePath) {
  const id = 'p' + (nextId++);
  const color = COLORS[colorIdx++ % COLORS.length];
  return { type: 'leaf', kind: 'editor', id, name: basename(filePath), color, filePath };
}

function makeBrowserLeaf(url) {
  const id = 'p' + (nextId++);
  const color = COLORS[colorIdx++ % COLORS.length];
  return { type: 'leaf', kind: 'webview', id, name: 'Browser', color, url: url || 'https://www.google.com' };
}

// True when this renderer runs in a phone browser over the remote bridge (window.termi
// is the web shim, version 'web-*'). <webview> is Electron-only, so browser panes fall
// back to opening a real browser tab there.
const isRemote = !!(window.termi && String(window.termi.version || '').startsWith('web'));

// ---------------- shared settings store (same "memory" on desktop & phone) ----------------
// The command launchers and other termi.* settings live in ONE store on the PC (the
// desktop via IPC, the phone via the remote server — both hit the same file). We seed
// localStorage from that store BEFORE anything reads it, then mirror future termi.* writes
// back to it. Result: opening termi on the phone shows the SAME buttons/settings as the
// desktop, and an edit on either side persists for both. No-op if the host has no store API.
(function syncSharedSettings() {
  const t = window.termi;
  if (!t || typeof t.settingsBootstrap !== 'function' || typeof t.settingsSet !== 'function') return;
  let seed = {};
  try { seed = t.settingsBootstrap() || {}; } catch (e) { seed = {}; }
  const hadStore = seed && Object.keys(seed).some((k) => k.indexOf('termi.') === 0);
  // 1) seed localStorage from the shared store (the store wins on load). Done BEFORE the
  //    write-through wrap below, so these seed writes don't echo back to the store.
  try {
    for (const k in seed) { if (k.indexOf('termi.') === 0 && seed[k] != null) localStorage.setItem(k, seed[k]); }
  } catch (e) { /* */ }
  // 2) mirror future termi.* writes (and removals) to the shared store.
  try {
    const proto = Storage.prototype;
    if (!proto.__termiWrapped) {
      proto.__termiWrapped = true;
      const origSet = proto.setItem, origRemove = proto.removeItem;
      proto.setItem = function (k, v) {
        origSet.call(this, k, v);
        if (typeof k === 'string' && k.indexOf('termi.') === 0) { try { window.termi.settingsSet(k, String(v)); } catch (e) { /* */ } }
      };
      proto.removeItem = function (k) {
        origRemove.call(this, k);
        if (typeof k === 'string' && k.indexOf('termi.') === 0) { try { window.termi.settingsSet(k, null); } catch (e) { /* */ } }
      };
    }
  } catch (e) { /* */ }
  // 3) first run on the DESKTOP with an empty store: migrate the existing localStorage
  //    into it, so the phone inherits buttons/settings created before this feature.
  if (!hadStore && !isRemote) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('termi.') === 0) { try { window.termi.settingsSet(k, localStorage.getItem(k)); } catch (e) { /* */ } }
      }
    } catch (e) { /* */ }
  }
})();

function basename(p) { return p ? p.split(/[\\/]/).pop() : ''; }
function extOf(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'apng']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']);

function detectMode(p) {
  const e = extOf(p);
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'csv') return 'csv';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (e === 'txt' || e === 'log' || e === '') return 'text';
  return 'code';
}
const MEDIA_MODES = new Set(['image', 'video', 'audio', 'pdf']);

// On the desktop a preview iframe/media element loads the file via file://. On the phone
// file:// points at the PHONE's disk (so previews were blank) — instead we route through
// the remote server's authenticated /fs/ endpoint, which serves the PC's file and its
// relatively-referenced assets (so an .html opened on the phone renders just like desktop).
function fileUrl(p) {
  const fwd = p.replace(/\\/g, '/');
  if (isRemote) return '/fs/' + fwd.split('/').map(encodeURIComponent).join('/');
  return 'file:///' + encodeURI(fwd);
}

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', py: 'python', java: 'java', c: 'c',
  h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust',
  rb: 'ruby', php: 'php', sh: 'shell', bash: 'shell', ps1: 'powershell',
  xml: 'xml', yaml: 'yaml', yml: 'yaml', sql: 'sql', md: 'markdown', markdown: 'markdown',
  toml: 'ini', ini: 'ini', dockerfile: 'dockerfile', vue: 'html', svelte: 'html',
};
function monacoLang(p) { return LANG_BY_EXT[extOf(p)] || 'plaintext'; }

// ---------------- Monaco bootstrap ----------------
let monaco = null;
let monacoReady = false;
const monacoQueue = [];
function whenMonaco(cb) { if (monacoReady) cb(); else monacoQueue.push(cb); }
(function loadMonaco() {
  const vsBase = new URL('../node_modules/monaco-editor/min/vs/', window.location.href).href;
  self.MonacoEnvironment = {
    getWorkerUrl() {
      return URL.createObjectURL(new Blob(
        [`self.MonacoEnvironment={baseUrl:'${vsBase}'};importScripts('${vsBase}base/worker/workerMain.js');`],
        { type: 'application/javascript' }
      ));
    },
  };
  require.config({ paths: { vs: vsBase.replace(/\/$/, '') } });
  require(['vs/editor/editor.main'], function () {
    monaco = window.monaco;
    monacoReady = true;
    monacoQueue.forEach((f) => f());
    monacoQueue.length = 0;
  }, function (err) {
    console.error('[termi] monaco failed to load:', err && (err.message || err));
  });
})();

let root = makeLeaf();
let focusedId = root.id;
let fullscreenId = null;
// A browser pane can auto-hide its OWN bar (per-pane `leaf.barHidden`): the bar collapses to
// reclaim the space and peeks back when the cursor reaches that pane's top edge — purely
// local, it never touches the app header or window. peekPaneId = the pane currently peeking.
let peekPaneId = null;
// Panes pulled off the layout but kept ALIVE (terminal/pty keeps running). They live in
// the "Ελαχιστοποιημένα" header tray; their views stay in the views Map (never destroyed)
// so restoring re-attaches the exact same session — same mechanism fullscreen uses to hide
// the other panes without killing them.
const minimized = [];

const workspace = document.getElementById('workspace');
const overlay = document.getElementById('overlay');

// ---------------- global command launchers ----------------
// Reusable buttons shown in every pane. Clicking runs in THAT pane.
// Two kinds of top-level item:
//   command  -> { id, type:'command', name, cwd, command, color }
//   category -> { id, type:'category', name, color, children:[ {id,name,cwd,command,color}... ] }
// A category chip opens a popup listing its commands (for organizing buttons).
function loadLaunchers() {
  try {
    const arr = JSON.parse(localStorage.getItem('termi.launchers') || '[]');
    // migrate older entries (no `type`) -> plain commands
    return arr.map((l) => (l && l.type === 'category')
      ? { ...l, type: 'category', children: Array.isArray(l.children) ? l.children : [] }
      : { ...l, type: 'command' });
  } catch { return []; }
}
// A launcher item is USER content if it has no `seedId` (every seeded default carries one).
// Used to tell an intentional "I deleted my buttons" state (seed-only / empty) apart from an
// accidental boot-time collapse, so the self-heal below never resurrects deleted buttons.
function hasUserContent(arr) {
  return Array.isArray(arr) && arr.some((l) => {
    if (l && l.type === 'category') {
      if (!l.seedId) return true;                       // a category the user made
      return Array.isArray(l.children) && l.children.some((c) => c && !c.seedId);
    }
    return !!l && !l.seedId;                             // a top-level command the user made
  });
}
// Persist the launchers. We ALSO keep a rolling backup (`termi.launchers.bak`) that mirrors
// the last state a USER action produced — seedDefaults() passes skipBackup so its automatic
// boot-time write can never overwrite a good backup with a seed-only set. The backup is the
// safety net the self-heal below restores from if launchers ever load collapsed.
function saveLaunchers(skipBackup) {
  localStorage.setItem('termi.launchers', JSON.stringify(launchers));
  if (!skipBackup) {
    try { localStorage.setItem('termi.launchers.bak', JSON.stringify(launchers)); } catch (e) { /* */ }
  }
}
let launchers = loadLaunchers();
// SELF-HEAL: if the launchers loaded WITHOUT any user content (e.g. a stale store won the
// load, or a boot glitch left only the seeded "AI" category) but the backup still holds real
// buttons, restore them BEFORE seedDefaults runs. Guarded by hasUserContent on both sides so a
// genuine "user deleted everything" state (backup also has no user content) is left untouched.
(function selfHealLaunchers() {
  if (hasUserContent(launchers)) return;
  let bak = [];
  try { bak = JSON.parse(localStorage.getItem('termi.launchers.bak') || '[]'); } catch (e) { bak = []; }
  if (hasUserContent(bak)) {
    launchers = bak;
    saveLaunchers();   // write the recovered set back to localStorage + shared store, refresh backup
  }
})();

// ---- default "AI" category, seeded once (respecting the user's edits/deletions) ----
// Ships pre-made: one category with ready install commands per AI coding agent,
// three buttons each (Windows / macOS / Linux). Each default carries a stable
// `seedId`. `termi.seededDefaults` is a map seedId -> the command we last seeded
// (or `true` for the category). On every launch we:
//   - add a button whose seedId was never offered (new tool / first run),
//   - REFRESH a button's command when WE ship a corrected one, but ONLY if the user
//     hasn't edited it (its current command still equals what we last seeded, or a
//     known legacy default in LEGACY_DEFAULT_COMMANDS for older `true`-only records),
//   - never touch a button the user edited, and never re-add one they deleted.
// So a fix like "Codex Windows: irm -> npm" reaches existing installs automatically,
// without clobbering anything the user changed.
const LEGACY_DEFAULT_COMMANDS = {
  // commands we shipped before and may now supersede; used to recognize an UNEDITED
  // button when the stored record predates per-command tracking (with or without the
  // later TLS prefix), so the corrected command reaches existing installs.
  'codex-win': [
    'irm https://chatgpt.com/codex/install.ps1 | iex',
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm https://chatgpt.com/codex/install.ps1 | iex',
  ],
  'claude-win': [
    'irm https://claude.ai/install.ps1 | iex',
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm https://claude.ai/install.ps1 | iex',
  ],
  'antig-win': ['irm https://antigravity.google/cli/install.ps1 | iex'],
};
const SEED_AI_CATEGORY = { seedId: 'ai-cat', name: '🤖 AI', color: '#8957e5' };
const SEED_AI_COMMANDS = [
  // Claude Code (Anthropic)
  { seedId: 'claude-win',   name: 'Claude · Windows', color: '#d97757', command: 'npm install -g @anthropic-ai/claude-code' },
  { seedId: 'claude-mac',   name: 'Claude · macOS',   color: '#d97757', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { seedId: 'claude-linux', name: 'Claude · Linux',   color: '#d97757', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  // Codex (OpenAI)
  { seedId: 'codex-win',    name: 'Codex · Windows',  color: '#10a37f', command: 'npm install -g @openai/codex' },
  { seedId: 'codex-mac',    name: 'Codex · macOS',    color: '#10a37f', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
  { seedId: 'codex-linux',  name: 'Codex · Linux',    color: '#10a37f', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
  // Antigravity (Google) — CLI
  { seedId: 'antig-win',    name: 'Antigravity · Windows', color: '#4285f4', command: '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm https://antigravity.google/cli/install.ps1 | iex' },
  { seedId: 'antig-mac',    name: 'Antigravity · macOS',   color: '#4285f4', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  { seedId: 'antig-linux',  name: 'Antigravity · Linux',   color: '#4285f4', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  // OpenClaw (open source — npm, needs Node 22.19+/24)
  { seedId: 'openclaw-win',   name: 'OpenClaw · Windows', color: '#e0603a', command: 'npm install -g openclaw@latest' },
  { seedId: 'openclaw-mac',   name: 'OpenClaw · macOS',   color: '#e0603a', command: 'npm install -g openclaw@latest' },
  { seedId: 'openclaw-linux', name: 'OpenClaw · Linux',   color: '#e0603a', command: 'npm install -g openclaw@latest' },
  // Hermes Agent (open source — Nous Research)
  { seedId: 'hermes-win',   name: 'Hermes · Windows', color: '#c678dd', command: 'pip install hermes-agent' },
  { seedId: 'hermes-mac',   name: 'Hermes · macOS',   color: '#c678dd', command: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash' },
  { seedId: 'hermes-linux', name: 'Hermes · Linux',   color: '#c678dd', command: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash' },
];

function seedDefaults() {
  // load the store (map seedId -> last seeded command | true); migrate the old
  // array-of-ids format to { id: true } so existing installs keep their history.
  let store = {};
  try {
    const raw = JSON.parse(localStorage.getItem('termi.seededDefaults') || '{}');
    if (Array.isArray(raw)) raw.forEach((id) => { store[id] = true; });
    else if (raw && typeof raw === 'object') store = raw;
  } catch { store = {}; }
  let n = 0;

  // a default button counts as UNEDITED (safe to refresh) if its current command is
  // what we last seeded, or — for legacy `true` records — a known prior default.
  const isUnedited = (existing, d) => {
    const last = store[d.seedId];
    if (typeof last === 'string') return existing.command === last;
    if (existing.command === d.command) return true;
    return (LEGACY_DEFAULT_COMMANDS[d.seedId] || []).includes(existing.command);
  };

  let cat = launchers.find((l) => l.type === 'category' && l.seedId === SEED_AI_CATEGORY.seedId);
  if (!cat && !(SEED_AI_CATEGORY.seedId in store)) {
    cat = {
      id: 'l' + Date.now(), type: 'category', seedId: SEED_AI_CATEGORY.seedId,
      name: SEED_AI_CATEGORY.name, color: SEED_AI_CATEGORY.color, children: [],
    };
    launchers.unshift(cat); // show the default category first
    store[SEED_AI_CATEGORY.seedId] = true;
    n++;
  }
  // if the category is gone but was once offered, the user deleted it -> don't recreate
  if (cat) {
    cat.children = cat.children || [];
    SEED_AI_COMMANDS.forEach((d, i) => {
      const existing = cat.children.find((c) => c.seedId === d.seedId);
      if (!(d.seedId in store)) {
        // never offered -> add it (first run / newly added tool)
        if (!existing) {
          cat.children.push({ id: 'l' + Date.now() + '_' + i, seedId: d.seedId, name: d.name, color: d.color, cwd: '', command: d.command });
        }
        store[d.seedId] = d.command;
        n++;
      } else if (existing) {
        // offered before and still present -> refresh command if the user hasn't edited it
        if (existing.command !== d.command && isUnedited(existing, d)) {
          existing.command = d.command;
          n++;
        }
        // upgrade a legacy/`true` record to the per-command baseline once it matches
        if (existing.command === d.command && store[d.seedId] !== d.command) {
          store[d.seedId] = d.command;
          n++;
        }
      }
      // offered before and now absent -> user deleted it -> respect, do nothing
    });
  }

  if (n) {
    saveLaunchers(true);   // skipBackup: seeding is automatic, must never clobber the user backup
    localStorage.setItem('termi.seededDefaults', JSON.stringify(store));
  }
}
seedDefaults();

// ---- saved web apps (define name+URL once, reusable browser launchers) ----
function loadWebApps() {
  try { return JSON.parse(localStorage.getItem('termi.webapps') || '[]'); }
  catch { return []; }
}
function saveWebApps() { localStorage.setItem('termi.webapps', JSON.stringify(webApps)); }
let webApps = loadWebApps();

// Auto-fetched favicon for a saved app: Google's favicon service resolves a site's logo from
// its hostname (cached by Chromium), so we don't store anything. Returns null for unparseable
// URLs; the <img> falls back to a globe icon on load error (offline / no favicon).
function faviconUrl(rawUrl) {
  try { return 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(new URL(rawUrl).hostname); }
  catch { return null; }
}

// What to do when a local (dev-server) URL is detected in terminal output:
// 'ask' (prompt each time), 'pane' (always a browser pane), 'external' (native browser).
function loadUrlAction() {
  const v = localStorage.getItem('termi.urlAction');
  return (v === 'pane' || v === 'external') ? v : 'ask';
}
function saveUrlAction() { localStorage.setItem('termi.urlAction', urlAction); }
let urlAction = loadUrlAction();

function runLauncher(L, paneId) {
  if (!views.get(paneId)) return;
  if (L.cwd) window.termi.write(paneId, ` cd "${L.cwd}"\r`);
  if (L.command) window.termi.write(paneId, `${L.command}\r`);
  focusTerminal(paneId);
}
function deleteLauncher(id) {
  launchers = launchers.filter((l) => l.id !== id);
  saveLaunchers();
  render();
}

function pointInRect(ev, el) {
  const r = el.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
}

// ---------------- terminal view cache ----------------
// id -> { el, term, fit, ro, opened, started }
const views = new Map();

const TERM_THEME = {
  background: '#0d1117',
  foreground: '#d3dae3',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88,166,255,0.38)',
  selectionForeground: '#f0f6fc',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

function mountView(leaf) {
  let v = views.get(leaf.id);
  if (v) return v;

  const el = document.createElement('div');
  el.className = 'term-host';

  const term = new Terminal({
    fontFamily: '"Cascadia Code", "Consolas", monospace',
    fontSize: leaf.fontSize || 13,
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1.22,
    letterSpacing: 0.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    scrollback: 5000,
    allowProposedApi: true,
    // cursor (the "pillar" at the active line) matches the pane's frame color
    theme: { ...TERM_THEME, cursor: leaf.color || TERM_THEME.cursor },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData((d) => window.termi.write(leaf.id, d));

  const ro = new ResizeObserver(() => scheduleFit(leaf.id));
  ro.observe(el);

  // Drag & drop file/folder paths from the explorer (or the OS) into the terminal.
  // Writes the path(s) to the prompt WITHOUT a newline so nothing auto-executes.
  el.addEventListener('dragover', (e) => {
    const isFiles = e.dataTransfer && e.dataTransfer.types && [...e.dataTransfer.types].includes('Files');
    if (draggedPaths.length || isFiles) {
      e.preventDefault();
      // Must match the source's effectAllowed ('move' for explorer rows) or the
      // browser shows "not-allowed" and never fires the drop event.
      e.dataTransfer.dropEffect = isFiles ? 'copy' : 'move';
      el.classList.add('term-droptarget');
    }
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('term-droptarget');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('term-droptarget');
    let paths = [];
    if (draggedPaths.length) {
      paths = [...draggedPaths];
    } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
      paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    } else {
      const t = e.dataTransfer.getData('text/plain');
      if (t) paths = [t];
    }
    if (!paths.length) return;
    const text = paths.map(quoteForShell).join(' ') + ' ';
    window.termi.write(leaf.id, text);
    focusTerminal(leaf.id);
    draggedPaths = []; draggedPath = null;
  });

  // Right-click: copy if there's a selection, otherwise paste from the clipboard.
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) {
      window.termi.clipboardWrite(sel);
      term.clearSelection();
    } else {
      const text = await window.termi.clipboardRead();
      if (text) window.termi.write(leaf.id, text);
    }
    term.focus();
  });

  v = { kind: 'terminal', el, term, fit, ro, opened: false, started: false, lastCols: 0, lastRows: 0 };
  views.set(leaf.id, v);
  return v;
}

const fitPending = new Set();
function scheduleFit(id) {
  if (fitPending.has(id)) return;
  fitPending.add(id);
  requestAnimationFrame(() => {
    fitPending.delete(id);
    activateView(id);
  });
}

function activateView(id) {
  const v = views.get(id);
  if (!v || v.kind !== 'terminal' || !v.el.isConnected) return;
  if (!v.opened) { v.term.open(v.el); v.opened = true; }
  try { v.fit.fit(); } catch { /* element not measurable yet */ }
  const cols = v.term.cols, rows = v.term.rows;
  if (cols < 1 || rows < 1) return;
  if (!v.started) {
    const leaf = findLeaf(id);
    window.termi.spawn(id, leaf ? leaf.cwd : null, cols, rows);
    v.started = true;
    v.lastCols = cols; v.lastRows = rows;
    return; // spawn already used these dims; no extra resize needed
  }
  // Only resize the pty when the geometry actually changed. Resizing on every
  // ResizeObserver tick makes PowerShell/PSReadLine repaint the input line,
  // which is what caused the duplicated/garbled text.
  if (cols !== v.lastCols || rows !== v.lastRows) {
    v.lastCols = cols; v.lastRows = rows;
    window.termi.resize(id, cols, rows);
  }
}

// ---- content zoom (font size of the pane's content, not the pane itself) ----
const ZOOM_MIN = 6, ZOOM_MAX = 40, ZOOM_DEFAULT = 13;
const zoomLabels = new Map(); // leaf.id -> percentage label element (refreshed each render)
function zoomPct(leaf) { return Math.round(((leaf.fontSize || ZOOM_DEFAULT) / ZOOM_DEFAULT) * 100) + '%'; }
function updateZoomLabel(leaf) {
  const el = zoomLabels.get(leaf.id);
  if (el) el.textContent = zoomPct(leaf);
}
function setZoom(leaf, size) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, size));
  if (next === (leaf.fontSize || ZOOM_DEFAULT)) return;
  leaf.fontSize = next;
  const v = views.get(leaf.id);
  if (v) v.fontSize = next;
  applyZoom(leaf);
  updateZoomLabel(leaf);
}
function zoomLeaf(leaf, delta) { setZoom(leaf, (leaf.fontSize || ZOOM_DEFAULT) + delta); }
function applyZoom(leaf) {
  const v = views.get(leaf.id);
  if (!v) return;
  const fs = leaf.fontSize || 13;
  if (v.kind === 'terminal') {
    try { v.term.options.fontSize = fs; } catch { /* */ }
    v.lastCols = v.lastRows = 0; // force a real refit at the new cell size
    scheduleFit(leaf.id);
  } else if (v.kind === 'editor') {
    if (v.editor) v.editor.updateOptions({ fontSize: fs });
    // CSV table + markdown/html rendered preview scale via font-size.
    if (v.preview) v.preview.style.fontSize = fs + 'px';
  }
}
function makeZoomButtons(leaf) {
  const out = document.createElement('button');
  out.className = 'zoom-btn';
  out.innerHTML = '<i class="codicon codicon-zoom-out"></i>';
  out.title = 'Σμίκρυνση περιεχομένου';
  out.addEventListener('click', (e) => { e.stopPropagation(); zoomLeaf(leaf, -1); });

  const pct = document.createElement('span');
  pct.className = 'zoom-pct';
  pct.textContent = zoomPct(leaf);
  pct.title = 'Επαναφορά στο 100%';
  pct.addEventListener('click', (e) => { e.stopPropagation(); setZoom(leaf, ZOOM_DEFAULT); });
  zoomLabels.set(leaf.id, pct);

  const inc = document.createElement('button');
  inc.className = 'zoom-btn';
  inc.innerHTML = '<i class="codicon codicon-zoom-in"></i>';
  inc.title = 'Μεγέθυνση περιεχομένου';
  inc.addEventListener('click', (e) => { e.stopPropagation(); zoomLeaf(leaf, +1); });
  return [out, pct, inc];
}

// Lock button (editor panes). Unlocked = the next file opened reuses this pane;
// locked = this pane is pinned to its file and new files open in a new pane.
function makeLockButton(leaf) {
  const btn = document.createElement('button');
  function paint() {
    btn.className = 'lock-btn' + (leaf.locked ? ' locked' : '');
    btn.innerHTML = `<i class="codicon codicon-${leaf.locked ? 'lock' : 'unlock'}"></i>`;
    btn.title = leaf.locked
      ? 'Κλειδωμένο: νέα αρχεία ανοίγουν σε νέο pane'
      : 'Ξεκλείδωτο: νέα αρχεία ανοίγουν εδώ';
  }
  paint();
  btn.addEventListener('click', (e) => { e.stopPropagation(); leaf.locked = !leaf.locked; paint(); });
  return btn;
}

function destroyView(id) {
  const v = views.get(id);
  if (!v) return;
  try { v.ro.disconnect(); } catch { /* */ }
  if (v.kind === 'terminal') {
    window.termi.kill(id);
    try { v.term.dispose(); } catch { /* */ }
  } else if (v.kind === 'editor') {
    clearTimeout(v.saveTimer);
    if (v.dirty && v.editor) window.termi.writeFile(v.filePath, v.editor.getModel().getValue());
    try { v.editor && v.editor.dispose(); } catch { /* */ }
    try { v.model && v.model.dispose(); } catch { /* */ }
  } else if (v.kind === 'webview') {
    nameInputs.delete(id);
    try { v.wv.remove(); } catch { /* */ }   // removing from the layer destroys the guest
    try { v.hotzone && v.hotzone.remove(); } catch { /* */ }
  }
  if (peekPaneId === id) peekPaneId = null;
  views.delete(id);
}

// pipe pty output -> xterm (registered once)
window.termi.onData(({ id, data }) => {
  const v = views.get(id);
  if (!v || v.kind !== 'terminal') return;
  v.term.write(data);
  detectLocalUrls(v, id, data);   // offer to open dev-server URLs (in a pane; via tunnel on the phone)
});
window.termi.onExit(({ id }) => {
  const v = views.get(id);
  if (v && v.kind === 'terminal') v.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
});

// ---------------- detect local (dev-server) URLs in terminal output ----------------
// When a dev server prints e.g. http://localhost:3000 we offer to open it (in a pane or
// the native browser). Output arrives in ANSI-coloured chunks and a URL can split across
// chunks, so we strip control codes and scan complete lines, carrying any partial line.
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"]*)?/gi;
const handledUrls = new Set();   // a URL is prompted/opened at most once per session

// Strip ANSI control sequences (no raw control bytes embedded in source).
const ANSI_ESC = String.fromCharCode(27), ANSI_BEL = String.fromCharCode(7);
function stripAnsi(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ANSI_ESC) {
      i++;
      if (s[i] === '[') { i++; while (i < s.length && !/[@-~]/.test(s[i])) i++; }            // CSI .. final byte
      else if (s[i] === ']') { i++; while (i < s.length && s[i] !== ANSI_BEL && s[i] !== ANSI_ESC) i++; } // OSC .. BEL/ESC
      continue;
    }
    out += s[i];
  }
  return out;
}

function detectLocalUrls(v, id, data) {
  const buf = (v.urlBuf || '') + stripAnsi(data);
  const nl = buf.lastIndexOf('\n');
  // only scan COMPLETE lines; carry the trailing partial line so a URL split across
  // chunks isn't matched half-formed (e.g. ".../:80" before "00/app" arrives).
  if (nl < 0) { v.urlBuf = buf.length > 2048 ? buf.slice(-2048) : buf; return; }
  const scan = buf.slice(0, nl);
  v.urlBuf = buf.slice(nl + 1);
  if (v.urlBuf.length > 2048) v.urlBuf = v.urlBuf.slice(-2048);
  let m;
  LOCAL_URL_RE.lastIndex = 0;
  while ((m = LOCAL_URL_RE.exec(scan))) {
    const url = m[0].replace(/[).,;:'"]+$/, '');   // drop trailing punctuation
    if (handledUrls.has(url)) continue;
    handledUrls.add(url);
    if (urlAction === 'pane') openLocalUrl(url, 'pane');
    else if (urlAction === 'external') openLocalUrl(url, 'external');
    else showUrlToast(id, url);
  }
}

function openLocalUrl(url, action) {
  // on the phone "external" (a real browser tab) can't reach the PC's localhost, so
  // every local URL opens in an in-app pane (served through a per-port tunnel).
  if (action === 'external' && !isRemote) window.termi.openExternal(url);
  else openBrowserPane(url);
}

// Small toast anchored at the bottom of the originating pane, with the choice + a
// "don't ask again" checkbox that remembers whichever action you pick.
function showUrlToast(paneId, url) {
  const pane = document.querySelector(`.pane[data-id="${paneId}"]`);
  const toast = document.createElement('div');
  toast.className = 'url-toast';
  toast.innerHTML = `
    <div class="ut-msg">Εντοπίστηκε <span class="ut-url"></span></div>
    <div class="ut-actions">
      <button class="ut-pane">Σε pane</button>
      <button class="ut-ext">Σε browser</button>
      <button class="ut-x" title="Κλείσιμο">✕</button>
    </div>
    <label class="ut-remember"><input type="checkbox"> Να μην ξαναρωτηθώ</label>`;
  toast.querySelector('.ut-url').textContent = url;
  // the phone has no usable "open in a real browser tab" (can't reach the PC's localhost)
  if (isRemote) { const ext = toast.querySelector('.ut-ext'); if (ext) ext.remove(); }
  document.body.appendChild(toast);

  const offset = (document.querySelectorAll('.url-toast').length - 1) * 70;
  const r = pane ? pane.getBoundingClientRect()
                 : { left: 0, width: window.innerWidth, bottom: window.innerHeight };
  toast.style.left = Math.round(r.left + r.width / 2) + 'px';
  toast.style.top = Math.round(r.bottom - 14 - offset) + 'px';

  const remember = toast.querySelector('.ut-remember input');
  const timer = setTimeout(close, 15000);
  function close() { clearTimeout(timer); toast.remove(); }
  function choose(action) {
    if (remember.checked) { urlAction = action; saveUrlAction(); }
    close();
    openLocalUrl(url, action);
  }
  toast.querySelector('.ut-pane').addEventListener('click', () => choose('pane'));
  toast.querySelector('.ut-ext').addEventListener('click', () => choose('external'));
  toast.querySelector('.ut-x').addEventListener('click', close);
}

// ---------------- web browser view (webview) ----------------
// The <webview> guest reloads if it's detached/reattached in the DOM, but render()
// rebuilds the whole pane tree (workspace.innerHTML='') on every layout change. So the
// webviews live in ONE persistent overlay layer and we position each one over an empty
// placeholder "slot" inside its pane body — they're never reparented, so they never
// reload on a split/resize/drag.
const webviewLayer = (() => {
  const l = document.createElement('div');
  l.id = 'webview-layer';
  document.body.appendChild(l);
  return l;
})();
const nameInputs = new Map(); // leaf.id -> pane-name input (so a page title can update it)

let webviewLayoutRaf = null;
function scheduleWebviewLayout() {
  if (webviewLayoutRaf) return;
  webviewLayoutRaf = requestAnimationFrame(() => { webviewLayoutRaf = null; layoutWebviews(); });
}
// per-slot observer: covers divider drags, window resizes, sidebar resize — anything that
// changes a slot's box makes us reposition the webview to keep it glued to its pane.
const webviewRO = new ResizeObserver(scheduleWebviewLayout);
window.addEventListener('resize', scheduleWebviewLayout);

function layoutWebviews() {
  const visible = new Set(visibleLeafIds());
  const base = webviewLayer.getBoundingClientRect();
  for (const [id, v] of views) {
    if (v.kind !== 'webview') continue;
    const hideHz = () => { if (v.hotzone) v.hotzone.style.display = 'none'; };
    if (!visible.has(id) || !v.slot || !v.slot.isConnected) { v.wv.style.display = 'none'; hideHz(); continue; }
    const r = v.slot.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { v.wv.style.display = 'none'; hideHz(); continue; }
    v.wv.style.display = 'flex';
    v.wv.style.left = (r.left - base.left) + 'px';
    v.wv.style.top = (r.top - base.top) + 'px';
    v.wv.style.width = r.width + 'px';
    v.wv.style.height = r.height + 'px';
    // reveal hot-zone over the pane's top edge only while this pane is auto-hiding its bar.
    // It lives in the layer (above the webview) so the hover registers despite the webview.
    const leaf = findLeaf(id);
    const pane = v.slot.closest('.pane');
    if (v.hotzone && leaf && leaf.barHidden && pane) {
      const pr = pane.getBoundingClientRect();
      let hzTop = pr.top - base.top;
      // When the app header is ALSO auto-hidden, its own hot-zone owns the very top 8px
      // (z-index 99, above this layer) and would swallow the hover for a pane that reaches
      // the top edge. Drop ours just below it so BOTH stay reachable — the app header on the
      // top line, this pane's bar (the drag grip) right under it.
      if (headerHideActive && hzTop < 9) hzTop = 9;
      v.hotzone.style.display = 'block';
      v.hotzone.style.left = (pr.left - base.left) + 'px';
      v.hotzone.style.top = hzTop + 'px';
      v.hotzone.style.width = pr.width + 'px';
    } else {
      hideHz();
    }
  }
}

// A thin hover strip over a browser pane's top edge that reveals its auto-hidden bar. It
// sits in #webview-layer above the webview (pointer-events:auto) so the hover is detected
// even though the webview covers the pane's content.
function makeBarHotzone(leaf) {
  const hz = document.createElement('div');
  hz.className = 'bar-hotzone';
  hz.style.display = 'none';
  hz.addEventListener('mouseenter', () => { if (leaf.barHidden) setBarPeek(leaf.id); });
  // The strip doubles as a drag handle: a browser pane's bar is packed with controls and
  // leaves almost no empty space to grab, so when the bar is hidden this is the reliable
  // place to grab the pane and move it in the grid (works whether or not it's peeking).
  hz.addEventListener('pointerdown', (e) => {
    focusedId = leaf.id;
    updateFocusClasses();
    startPaneDrag(e, leaf);
  });
  webviewLayer.appendChild(hz);
  return hz;
}

function mountWebviewView(leaf) {
  let v = views.get(leaf.id);
  if (v) return v;
  if (isRemote) return mountIframeView(leaf);

  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:webapps');  // one shared, persistent profile -> logins stick
  // Spoof a plain Chrome UA (no "Electron" token) so Google OAuth doesn't reject the
  // embedded webview with "There was an error logging you in" / "browser may not be secure".
  wv.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  wv.setAttribute('allowpopups', 'true');  // let OAuth (Google login) window.open popups through
  wv.setAttribute('src', leaf.url || 'about:blank');
  wv.style.display = 'none';
  // entering the guest area means the cursor is past the headers -> collapse any peek (the
  // guest eats mousemove, so this is our only reliable "left the header" signal here).
  wv.addEventListener('mouseenter', collapsePeeks);
  webviewLayer.appendChild(wv);

  // el/ro kept for the shared views-Map contract (destroyView calls v.ro.disconnect()).
  v = { kind: 'webview', el: wv, wv, ro: { disconnect() {} }, slot: null, urlInput: null, hotzone: null };
  v.hotzone = makeBarHotzone(leaf);

  const syncUrl = (u) => {
    if (!u) return;
    leaf.url = u;
    if (v.urlInput && document.activeElement !== v.urlInput) v.urlInput.value = u;
  };
  wv.addEventListener('did-navigate', (e) => syncUrl(e.url));
  wv.addEventListener('did-navigate-in-page', (e) => syncUrl(e.url));
  wv.addEventListener('page-title-updated', (e) => {
    if (!e.title) return;
    leaf.name = e.title;
    const ni = nameInputs.get(leaf.id);
    if (ni && document.activeElement !== ni) ni.value = e.title;
  });
  views.set(leaf.id, v);
  return v;
}

// ---- phone (remote) browser pane = an <iframe> (no <webview> off Electron) ----
// It still lives in the persistent overlay layer (so it never reloads on a re-render)
// and is only ever pointed at a PC dev-server exposed through its own tunnel. Like the
// webview it's positioned over its pane's slot by layoutWebviews (which uses v.wv).
function mountIframeView(leaf) {
  const fr = document.createElement('iframe');
  fr.className = 'wv-frame';
  fr.setAttribute('src', leaf.url || 'about:blank');
  fr.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
  fr.style.display = 'none';
  fr.addEventListener('mouseenter', collapsePeeks);  // see the webview note above
  webviewLayer.appendChild(fr);
  const v = { kind: 'webview', el: fr, wv: fr, ro: { disconnect() {} }, slot: null, urlInput: null, remote: true, hotzone: null };
  v.hotzone = makeBarHotzone(leaf);
  views.set(leaf.id, v);
  return v;
}

// Parse a localhost-style URL into { full, host, port, path }, or null if it isn't local.
function parseLocalUrl(raw) {
  const u = (raw || '').trim();
  const m = u.match(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/[^\s]*)?$/i);
  if (!m) return null;
  return { full: u, host: m[1], port: m[2] ? parseInt(m[2], 10) : 80, path: m[3] || '/' };
}
// Normalize loose input (a bare port "3000", "localhost:3000", a full URL) to a parsed
// local URL, or null if it isn't a localhost target.
function toLocalUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  let u = s;
  if (/^\d+$/.test(s)) u = 'http://localhost:' + s;
  else if (!/^https?:\/\//i.test(s)) u = 'http://' + s;
  return parseLocalUrl(u);
}
// A message shown inside a browser pane's slot, behind the iframe (e.g. "connecting…").
function setSlotMsg(v, msg) { if (v && v.slot) v.slot.textContent = msg || ''; }

// Point a remote browser pane at a localhost URL: expose its port through a tunnel, then
// load the resulting public URL in the iframe. Keeps leaf.localUrl for a friendly display.
function navigateRemotePane(v, leaf, raw) {
  const parsed = toLocalUrl(raw);
  if (!parsed) { setSlotMsg(v, 'Στο κινητό το pane δουλεύει μόνο για localhost.'); return; }
  leaf.localUrl = parsed.full;
  leaf.name = 'localhost:' + parsed.port;
  const ni = nameInputs.get(leaf.id); if (ni) ni.value = leaf.name;
  if (v && v.urlInput && document.activeElement !== v.urlInput) v.urlInput.value = parsed.full;
  setSlotMsg(v, 'Σύνδεση μέσω tunnel…');
  window.termi.exposePort(parsed.port).then((res) => {
    const vv = views.get(leaf.id);
    if (!vv) return;
    if (!res || !res.ok || !res.value || !res.value.url) { setSlotMsg(vv, 'Αποτυχία σύνδεσης στη θύρα ' + parsed.port); return; }
    leaf.url = res.value.url.replace(/\/$/, '') + parsed.path;
    try { vv.wv.src = leaf.url; } catch { /* */ }
  });
}

// Turn what the user typed into a URL, the way a browser address bar does:
// localhost / IPs / host:port -> http (dev servers), a domain -> https, else a search.
function resolveAddress(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  // already has a scheme (http:, file:, about:, …); the (?!\d) keeps "localhost:3000"
  // from looking like a "localhost:" scheme so it's treated as host:port instead.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  const host = s.split(/[/?#]/)[0];                        // strip path/query -> host[:port]
  const isLocalhost = /^localhost(:\d+)?$/i.test(host);
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host);
  const isIpv6 = /^\[[0-9a-fA-F:]+\](:\d+)?$/.test(host);
  if (isLocalhost || isIpv4 || isIpv6) return 'http://' + s;   // local -> http
  if (!/\s/.test(s) && /^[^\s/?#]+\.[^\s/?#]{2,}/.test(host)) return 'https://' + s;  // a domain -> https
  if (/^[^\s/?#]+:\d+$/.test(host)) return 'http://' + s;      // bare host:port -> http
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);  // otherwise: search
}

function navigateWebview(v, leaf, raw) {
  const url = resolveAddress(raw);
  if (!url) return;
  leaf.url = url;
  try { v.wv.src = url; } catch { /* */ }
}

// ---------------- editor view cache ----------------

function mountEditorView(leaf) {
  let v = views.get(leaf.id);
  if (v) return v;

  const el = document.createElement('div');
  el.className = 'editor-host';
  const codeWrap = document.createElement('div');
  codeWrap.className = 'editor-code';
  const preview = document.createElement('div');
  preview.className = 'editor-preview';
  preview.style.display = 'none';
  el.append(codeWrap, preview);

  const mode = detectMode(leaf.filePath);
  v = {
    kind: 'editor', el, codeWrap, preview,
    fontSize: leaf.fontSize || 13,
    filePath: leaf.filePath, mode,
    editor: null, model: null, iframe: null,
    showPreview: (mode === 'markdown' || mode === 'html'),
    ro: null, saveTimer: null, dirty: false, statusText: '', statusEl: null,
  };
  const ro = new ResizeObserver(() => { if (v.editor) v.editor.layout(); });
  ro.observe(el);
  v.ro = ro;
  views.set(leaf.id, v);

  loadEditorFile(v);
  return v;
}

function renderMedia(v) {
  v.codeWrap.style.display = 'none';
  v.preview.style.display = 'block';
  v.preview.className = 'editor-preview media-view';
  v.preview.innerHTML = '';
  const url = fileUrl(v.filePath);
  let el;
  if (v.mode === 'image') {
    el = document.createElement('img');
    el.className = 'media-img';
    el.src = url;
  } else if (v.mode === 'video') {
    el = document.createElement('video');
    el.className = 'media-video';
    el.controls = true;
    el.src = url;
  } else if (v.mode === 'audio') {
    el = document.createElement('audio');
    el.className = 'media-audio';
    el.controls = true;
    el.src = url;
  } else { // pdf
    el = document.createElement('iframe');
    el.className = 'media-pdf';
    el.src = url;
  }
  v.preview.appendChild(el);
}

async function loadEditorFile(v) {
  v.mode = detectMode(v.filePath);

  if (MEDIA_MODES.has(v.mode)) { renderMedia(v); return; }

  const res = await window.termi.readFile(v.filePath);
  const content = res.ok ? res.value : `Αδυναμία ανοίγματος αρχείου:\n${res.error || ''}`;

  if (v.mode === 'csv') {
    v.codeWrap.style.display = 'none';
    v.preview.style.display = 'block';
    v.preview.className = 'editor-preview csv-view';
    v.csv = content;
    v.preview.innerHTML = renderCsv(content);
    return;
  }

  whenMonaco(() => {
    const lang = v.mode === 'markdown' ? 'markdown' : monacoLang(v.filePath);
    if (!v.editor) {
      v.editor = monaco.editor.create(v.codeWrap, {
        value: content,
        language: lang,
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        fontSize: v.fontSize || 13,
        fontFamily: '"Cascadia Code", "Consolas", monospace',
        scrollBeyondLastLine: false,
        wordWrap: v.mode === 'markdown' || v.mode === 'text' ? 'on' : 'off',
        tabSize: 2,
        scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
      });
      v.model = v.editor.getModel();
      v.editor.onDidChangeModelContent(() => scheduleSave(v));
    } else {
      const old = v.editor.getModel();
      const m = monaco.editor.createModel(content, lang);
      v.editor.setModel(m);
      v.model = m;
      if (old) old.dispose();
    }
    if (v.mode === 'markdown' || v.mode === 'html') { v.showPreview = true; applyPreview(v); }
    else { v.showPreview = false; v.codeWrap.style.display = 'block'; v.preview.style.display = 'none'; v.editor.layout(); }
  });
}

function applyPreview(v) {
  if (v.showPreview) {
    if (v.mode === 'markdown') {
      const md = v.editor ? v.editor.getModel().getValue() : '';
      v.preview.className = 'editor-preview md-view';
      v.preview.innerHTML = window.marked ? window.marked.parse(md) : '<pre>' + escapeHtml(md) + '</pre>';
    } else if (v.mode === 'html') {
      v.preview.className = 'editor-preview html-view';
      showHtmlPreview(v);
    }
    v.preview.style.display = 'block';
    v.codeWrap.style.display = 'none';
  } else {
    v.codeWrap.style.display = 'block';
    v.preview.style.display = 'none';
    if (v.editor) v.editor.layout();
  }
}

async function showHtmlPreview(v) {
  // flush any pending save so the rendered page reflects the latest edits
  clearTimeout(v.saveTimer);
  if (v.editor && v.dirty) {
    await window.termi.writeFile(v.filePath, v.editor.getModel().getValue());
    v.dirty = false;
    setEditorStatus(v, 'αποθηκεύτηκε ✓');
  }
  if (!v.iframe) {
    v.iframe = document.createElement('iframe');
    v.iframe.className = 'html-frame';
    v.preview.appendChild(v.iframe);
  }
  // cache-bust so reloading after edits shows fresh content
  v.iframe.src = fileUrl(v.filePath) + '?t=' + new Date().getTime();
}

function scheduleSave(v) {
  if (v.reloading) return; // content was just refreshed from disk, not a user edit
  v.dirty = true;
  setEditorStatus(v, '…');
  clearTimeout(v.saveTimer);
  v.saveTimer = setTimeout(async () => {
    const data = v.editor.getModel().getValue();
    const res = await window.termi.writeFile(v.filePath, data);
    v.dirty = false;
    setEditorStatus(v, res.ok ? 'αποθηκεύτηκε ✓' : 'σφάλμα ⚠');
  }, 400);
}

function setEditorStatus(v, text) {
  v.statusText = text;
  if (v.statusEl) v.statusEl.textContent = text;
}

// Reload open editor panels whose file changed on disk (e.g. a benchmark rewriting
// output). Skips panels with unsaved edits so we never clobber what you're typing.
// Our own auto-save can't loop this: after a save, disk === model, so nothing reloads.
async function refreshOpenEditors() {
  for (const v of views.values()) {
    if (v.kind !== 'editor' || v.dirty) continue;
    if (MEDIA_MODES.has(v.mode)) {
      // Re-point image/pdf at the file with a cache-bust; leave video/audio playback alone.
      if (v.mode === 'image' || v.mode === 'pdf') {
        const m = v.preview.querySelector('img, iframe');
        if (m) m.src = fileUrl(v.filePath) + '?t=' + Date.now();
      }
      continue;
    }
    const res = await window.termi.readFile(v.filePath);
    if (!res.ok) continue; // file gone/unreadable — leave the panel as-is
    const disk = res.value;
    if (v.mode === 'csv') {
      if (v.csv !== disk) { v.csv = disk; v.preview.innerHTML = renderCsv(disk); }
      continue;
    }
    if (!v.editor || !v.model || v.model.getValue() === disk) continue;
    v.reloading = true;
    const state = v.editor.saveViewState();
    v.model.setValue(disk);
    if (state) v.editor.restoreViewState(state);
    v.reloading = false;
    v.dirty = false;
    setEditorStatus(v, 'ανανεώθηκε ↻');
    if (v.showPreview && (v.mode === 'markdown' || v.mode === 'html')) applyPreview(v);
  }
}

// ---------------- CSV viewer ----------------

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function renderCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return '<div class="tree-empty">Άδειο CSV</div>';
  let html = '<table class="csv-table">';
  rows.forEach((r, i) => {
    const tag = i === 0 ? 'th' : 'td';
    html += '<tr><td class="csv-rownum">' + (i === 0 ? '#' : i) + '</td>' +
      r.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
  });
  return html + '</table>';
}

// ---------------- open file in editor pane ----------------

// The editor pane that should receive the next opened file, when one is reusable.
let activeEditorId = null;

// Pick an unlocked editor pane to reuse for a newly-opened file:
// the focused pane if it qualifies, else the last one we opened into, else any.
function reusableEditorLeaf() {
  const f = findLeaf(focusedId);
  if (f && f.kind === 'editor' && !f.locked) return f;
  if (activeEditorId) {
    const a = findLeaf(activeEditorId);
    if (a && a.kind === 'editor' && !a.locked) return a;
  }
  let found = null;
  (function walk(n) {
    if (found || !n) return;
    if (n.type === 'leaf') { if (n.kind === 'editor' && !n.locked) found = n; }
    else n.children.forEach(walk);
  })(root);
  return found;
}

function openFile(filePath) {
  // already open? just focus that panel
  for (const [id, v] of views) {
    if (v.kind === 'editor' && v.filePath === filePath) {
      focusedId = id;
      activeEditorId = id;
      updateFocusClasses();
      focusView(id);
      return;
    }
  }
  // reuse an unlocked editor pane in place (keeps the layout put), unless none exist
  const reuse = reusableEditorLeaf();
  if (reuse) {
    destroyView(reuse.id);          // flush+dispose the old file's editor first
    reuse.filePath = filePath;
    reuse.name = basename(filePath);
    focusedId = reuse.id;
    activeEditorId = reuse.id;
    render();
    return;
  }
  // otherwise open as a NEW editor panel in the orchestra
  const leaf = makeEditorLeaf(filePath);
  if (!root) {
    root = leaf;
  } else {
    const target = findLeaf(focusedId) || firstLeaf(root);
    splitTarget(target, leaf, 'right');
  }
  focusedId = leaf.id;
  activeEditorId = leaf.id;
  render();
}

// ---------------- tree helpers ----------------

function findLeaf(id) {
  function walk(node) {
    if (!node) return null;
    if (node.type === 'leaf') return node.id === id ? node : null;
    for (const c of node.children) { const r = walk(c); if (r) return r; }
    return null;
  }
  return walk(root);
}

function firstLeaf(node) {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0]);
}

function findParentInfo(target) {
  function walk(node) {
    if (node.type === 'split') {
      for (let i = 0; i < node.children.length; i++) {
        if (node.children[i] === target) return { parent: node, index: i };
        const r = walk(node.children[i]);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(root);
}

function replaceNode(target, replacement) {
  if (target === root) { root = replacement; return; }
  const info = findParentInfo(target);
  if (info) info.parent.children[info.index] = replacement;
}

function removeLeaf(leaf) {
  const info = findParentInfo(leaf);
  if (!info) return false;
  const sibling = info.parent.children[1 - info.index];
  replaceNode(info.parent, sibling);
  return true;
}

function splitTarget(target, newLeaf, zone) {
  const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
  const first = (zone === 'left' || zone === 'top');
  const children = first ? [newLeaf, target] : [target, newLeaf];
  replaceNode(target, { type: 'split', dir, children, sizes: [50, 50] });
}

function swapNodes(a, b) {
  const ia = findParentInfo(a), ib = findParentInfo(b);
  if (!ia || !ib) return; // root involved => only one leaf, nothing to swap
  ia.parent.children[ia.index] = b;
  ib.parent.children[ib.index] = a;
}

function visibleLeafIds() {
  if (fullscreenId) return [fullscreenId];
  if (!root) return [];   // empty workspace (e.g. last pane minimized/closed) -> nothing visible
  const ids = [];
  (function walk(n) {
    if (n.type === 'leaf') ids.push(n.id);
    else n.children.forEach(walk);
  })(root);
  return ids;
}

// ---------------- rendering ----------------

function render() {
  webviewRO.disconnect();        // slots are about to be rebuilt; re-observe the new ones
  workspace.innerHTML = '';
  if (!root) { renderEmptyState(); layoutWebviews(); return; }
  if (fullscreenId) {
    const leaf = findLeaf(fullscreenId);
    if (leaf) {
      const p = renderPane(leaf);
      p.style.position = 'absolute';
      p.style.inset = '6px';
      workspace.appendChild(p);
    } else {
      fullscreenId = null;
      workspace.appendChild(renderNode(root));
    }
  } else {
    workspace.appendChild(renderNode(root));
  }
  visibleLeafIds().forEach(scheduleFit);
  scheduleWebviewLayout();
}

function renderEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const btn = document.createElement('button');
  btn.className = 'empty-add';
  btn.textContent = '+ Νέο terminal';
  btn.addEventListener('click', addPane);
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.textContent = 'Ctrl+T';
  wrap.append(btn, hint);
  workspace.appendChild(wrap);
}

function renderNode(node) {
  return node.type === 'leaf' ? renderPane(node) : renderSplit(node);
}

function renderSplit(node) {
  const el = document.createElement('div');
  el.className = 'node ' + node.dir;
  const childEls = [];
  node.children.forEach((child, i) => {
    const c = renderNode(child);
    c.style.flexGrow = '0';
    c.style.flexShrink = '1';
    c.style.flexBasis = node.sizes[i] + '%';
    childEls.push(c);
    el.appendChild(c);
    if (i < node.children.length - 1) {
      el.appendChild(makeDivider(node, i, el, childEls));
    }
  });
  return el;
}

function makeDivider(node, i, containerEl, childEls) {
  const d = document.createElement('div');
  d.className = 'divider ' + (node.dir === 'row' ? 'row-divider' : 'col-divider');
  d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    d.classList.add('dragging');
    const horizontal = node.dir === 'row';
    const total = horizontal ? containerEl.clientWidth : containerEl.clientHeight;
    const startPos = horizontal ? e.clientX : e.clientY;
    const startA = node.sizes[i];
    const sumAB = node.sizes[i] + node.sizes[i + 1];
    const MIN = 8;

    function move(ev) {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const deltaPct = (pos - startPos) / total * 100;
      let a = Math.max(MIN, Math.min(sumAB - MIN, startA + deltaPct));
      node.sizes[i] = a;
      node.sizes[i + 1] = sumAB - a;
      childEls[i].style.flexBasis = node.sizes[i] + '%';
      childEls[i + 1].style.flexBasis = node.sizes[i + 1] + '%';
    }
    function up() {
      d.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return d;
}

function renderPane(leaf) {
  const pane = document.createElement('div');
  pane.className = 'pane' + (leaf.id === focusedId ? ' focused' : '');
  pane.dataset.id = leaf.id;
  pane.style.borderColor = leaf.color;

  // --- bar ---
  const bar = document.createElement('div');
  bar.className = 'pane-bar';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = leaf.color;
  dot.title = 'Χρώμα πλαισίου';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'color-input';
  colorInput.value = leaf.color;
  dot.addEventListener('click', (e) => { e.stopPropagation(); colorInput.click(); });
  colorInput.addEventListener('input', () => {
    leaf.color = colorInput.value;
    pane.style.borderColor = leaf.color;
    dot.style.background = leaf.color;
    // keep the terminal cursor in sync with the frame color
    const v = views.get(leaf.id);
    if (v && v.kind === 'terminal') {
      try { v.term.options.theme = { ...TERM_THEME, cursor: leaf.color }; } catch { /* */ }
    }
  });

  const name = document.createElement('input');
  name.className = 'pane-name';
  name.value = leaf.name;
  name.spellcheck = false;
  name.addEventListener('change', () => { leaf.name = name.value; });

  const minBtn = document.createElement('button');
  // Windows-style trio (minimize / maximize / close), all 'bar-essential' so they survive
  // the @container collapse on very narrow panes.
  minBtn.className = 'min-btn bar-essential';
  minBtn.innerHTML = '<i class="codicon codicon-chrome-minimize"></i>';
  minBtn.title = 'Ελαχιστοποίηση';
  minBtn.addEventListener('click', (e) => { e.stopPropagation(); minimizePane(leaf); });

  const fsBtn = document.createElement('button');
  // 'bar-essential' keeps these visible even when a very narrow pane
  // collapses the rest of the header onto / off the second line (styles.css @container).
  fsBtn.className = 'fs-btn bar-essential';
  fsBtn.textContent = fullscreenId === leaf.id ? '🗗' : '⛶';
  fsBtn.title = 'Fullscreen';
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fullscreenId = fullscreenId === leaf.id ? null : leaf.id;
    render();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn bar-essential';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Κλείσιμο';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePane(leaf); });

  // --- kind-specific bar buttons + body ---
  const body = document.createElement('div');
  let launcherBar = null;

  if (leaf.kind === 'editor') {
    pane.classList.add('editor-pane');
    const v = mountEditorView(leaf);

    const midBtns = [];
    if (v.mode === 'markdown' || v.mode === 'html') {
      const mdBtn = document.createElement('button');
      mdBtn.textContent = v.showPreview ? '✎ raw' : '👁 view';
      mdBtn.title = 'Εναλλαγή raw / προβολή';
      mdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        v.showPreview = !v.showPreview;
        mdBtn.textContent = v.showPreview ? '✎ raw' : '👁 view';
        applyPreview(v);
      });
      midBtns.push(mdBtn);
    }
    const status = document.createElement('span');
    status.className = 'edit-status';
    status.textContent = v.statusText;
    v.statusEl = status;

    bar.append(dot, colorInput, name, makeLockButton(leaf), ...makeZoomButtons(leaf), ...midBtns, status, minBtn, fsBtn, closeBtn);
    body.className = 'pane-body editor-body';
    if (v.preview) v.preview.style.fontSize = (leaf.fontSize || 13) + 'px';
    body.appendChild(v.el);
  } else if (leaf.kind === 'webview') {
    pane.classList.add('webview-pane');
    if (leaf.barHidden) pane.classList.add('bar-auto');
    const v = mountWebviewView(leaf);
    nameInputs.set(leaf.id, name);

    const navBtn = (icon, title, fn) => {
      const b = document.createElement('button');
      b.className = 'wv-nav';
      b.innerHTML = `<i class="codicon codicon-${icon}"></i>`;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); try { fn(); } catch { /* */ } });
      return b;
    };
    // reload: <webview>.reload() on desktop; on the phone an <iframe> reloads by re-setting src.
    const reload = navBtn('refresh', 'Ανανέωση', () => {
      if (isRemote) { try { v.wv.src = leaf.url || v.wv.src; } catch { /* */ } }
      else v.wv.reload();
    });

    const urlInput = document.createElement('input');
    urlInput.className = 'wv-url';
    urlInput.spellcheck = false;
    urlInput.value = isRemote ? (leaf.localUrl || '') : (leaf.url || '');
    urlInput.placeholder = isRemote ? 'localhost θύρα ή URL…' : 'Διεύθυνση ή αναζήτηση…';
    urlInput.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a pane drag
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (isRemote) navigateRemotePane(v, leaf, urlInput.value);
      else navigateWebview(v, leaf, urlInput.value);
      urlInput.blur();
    });
    v.urlInput = urlInput;

    // auto-hide this pane's bar to maximize the page area; it peeks back when the cursor
    // reaches the pane's top edge. Scoped to this pane only — nothing else is affected.
    const fullBtn = navBtn(
      leaf.barHidden ? 'screen-normal' : 'screen-full',
      leaf.barHidden ? 'Εμφάνιση μπάρας' : 'Απόκρυψη μπάρας (peek στο πάνω άκρο)',
      () => toggleBarHidden(leaf),
    );

    // back/fwd + save-as-app are desktop-only (cross-origin iframe can't navigate history,
    // and the phone's browser panes are localhost-only, not arbitrary saveable sites).
    if (isRemote) {
      bar.append(dot, colorInput, name, reload, urlInput, fullBtn, minBtn, fsBtn, closeBtn);
    } else {
      const back = navBtn('arrow-left', 'Πίσω', () => { if (v.wv.canGoBack && v.wv.canGoBack()) v.wv.goBack(); });
      const fwd = navBtn('arrow-right', 'Μπροστά', () => { if (v.wv.canGoForward && v.wv.canGoForward()) v.wv.goForward(); });
      // Google/OAuth logins (e.g. Claude) can't complete inside a <webview> because
      // window.opener doesn't survive the popup boundary. This opens the current page
      // in a real window that shares the pane's session; after logging in there and
      // closing it, the pane reloads already logged in.
      const login = navBtn('link-external', 'Σύνδεση σε ξεχωριστό παράθυρο', async () => {
        try { await window.termi.openLoginWindow(leaf.url); v.wv.reload(); } catch { /* */ }
      });
      const star = navBtn('star-empty', 'Αποθήκευση ως εφαρμογή', () => saveCurrentAsApp(leaf));
      bar.append(dot, colorInput, name, back, fwd, reload, urlInput, login, star, fullBtn, minBtn, fsBtn, closeBtn);
    }
    body.className = 'pane-body webview-body';
    const slot = document.createElement('div');
    slot.className = 'webview-slot';
    v.slot = slot;
    webviewRO.observe(slot);
    body.appendChild(slot);
  } else {
    const launcherBtn = document.createElement('button');
    launcherBtn.textContent = '⚡';
    launcherBtn.title = 'Νέο κουμπί / κατηγορία';
    launcherBtn.addEventListener('click', (e) => { e.stopPropagation(); openLauncherModal(); });

    const folderBtn = document.createElement('button');
    folderBtn.textContent = '📁';
    folderBtn.title = 'Ορισμός φακέλου εργασίας';
    folderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await window.termi.pickFolder(leaf.cwd);
      if (!p) return;
      leaf.cwd = p;
      folderBtn.title = 'Φάκελος: ' + p;
      const v = views.get(leaf.id);
      if (v && v.started) window.termi.write(leaf.id, ` cd "${p}"\r`);
    });

    bar.append(dot, colorInput, name, ...makeZoomButtons(leaf), launcherBtn, folderBtn, minBtn, fsBtn, closeBtn);
    launcherBar = launchers.length ? renderLauncherBar(leaf) : null;
    body.className = 'pane-body';
    body.appendChild(mountView(leaf).el);
  }

  bar.addEventListener('pointerdown', (e) => startPaneDrag(e, leaf));
  pane.addEventListener('pointerdown', () => { focusedId = leaf.id; updateFocusClasses(); focusView(leaf.id); });

  if (launcherBar) pane.append(bar, launcherBar, body);
  else pane.append(bar, body);
  return pane;
}

function focusView(id) {
  const v = views.get(id);
  if (!v) return;
  if (v.kind === 'terminal' && v.opened) { try { v.term.focus(); } catch { /* */ } }
  else if (v.kind === 'editor' && v.editor) { try { v.editor.focus(); } catch { /* */ } }
}

function renderLauncherBar(leaf) {
  const lb = document.createElement('div');
  lb.className = 'launcher-bar';
  launchers.forEach((L) => {
    const chip = document.createElement('button');
    chip.className = 'launcher-chip' + (L.type === 'category' ? ' chip-category' : '');
    chip.dataset.lid = L.id;
    chip.style.borderColor = L.color || 'var(--border)';

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = L.name;

    const del = document.createElement('span');
    del.className = 'chip-del';
    del.textContent = '✕';
    del.title = 'Διαγραφή κουμπιού';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteLauncher(L.id); });

    if (L.type === 'category') {
      chip.title = 'Κατηγορία: ' + L.name + ` (${(L.children || []).length})`;
      const caret = document.createElement('span');
      caret.className = 'chip-caret';
      caret.textContent = '▾';
      chip.append(label, caret, del);
    } else {
      const tip = [];
      if (L.cwd) tip.push('📁 ' + L.cwd);
      if (L.command) tip.push('▸ ' + L.command);
      chip.title = tip.join('\n');
      chip.append(label, del);
    }

    // pointerdown -> potential drag-to-reorder; a plain click (no drag) runs it
    // (or, for a category, opens its popup)
    chip.addEventListener('pointerdown', (e) => startChipDrag(e, L, leaf.id, chip, lb));
    lb.appendChild(chip);
  });
  return lb;
}

function startChipDrag(e, L, paneId, chip, bar) {
  if (e.button !== 0) return;
  if (e.target.closest('.chip-del')) return; // let delete handle it
  const startX = e.clientX, startY = e.clientY;
  let dragging = false;
  let dropCatEl = null; // a category chip currently targeted as "drop into"

  function clearDropCat() {
    if (dropCatEl) dropCatEl.classList.remove('chip-drop-into');
    dropCatEl = null;
  }

  function move(ev) {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      chip.classList.add('chip-dragging');
    }
    // a plain command can be dropped INTO a category chip (not another category)
    if (L.type === 'command') {
      const overCat = [...bar.querySelectorAll('.launcher-chip.chip-category')]
        .find((c) => c !== chip && pointInRect(ev, c));
      if (overCat) {
        if (overCat !== dropCatEl) { clearDropCat(); dropCatEl = overCat; dropCatEl.classList.add('chip-drop-into'); }
        return; // targeting a category -> skip reorder
      }
    }
    clearDropCat();
    // otherwise: live reorder within the bar (unchanged behavior)
    const siblings = [...bar.querySelectorAll('.launcher-chip:not(.chip-dragging)')];
    let next = null;
    for (const s of siblings) {
      const r = s.getBoundingClientRect();
      if (ev.clientX < r.left + r.width / 2) { next = s; break; }
    }
    if (next) bar.insertBefore(chip, next);
    else bar.appendChild(chip);
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    chip.classList.remove('chip-dragging');
    if (!dragging) {
      clearDropCat();
      if (L.type === 'category') openCategoryMenu(L, paneId, chip);
      else runLauncher(L, paneId);
      return;
    }
    // dropped onto a category -> move this top-level command inside it
    if (dropCatEl) {
      const catId = dropCatEl.dataset.lid;
      clearDropCat();
      const cat = launchers.find((l) => l.id === catId && l.type === 'category');
      if (cat && cat.id !== L.id) {
        launchers = launchers.filter((l) => l.id !== L.id);
        cat.children = cat.children || [];
        const { type, ...cmd } = L; // store children without the top-level `type`
        cat.children.push(cmd);
        saveLaunchers();
        render();
        return;
      }
    }
    clearDropCat();
    // commit the reorder
    const order = [...bar.querySelectorAll('.launcher-chip')].map((c) => c.dataset.lid);
    launchers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveLaunchers();
    render();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Drag a command OUT of a category popup: drop on the bar -> becomes a top-level
// chip; drop on another category chip -> moves between categories; a plain click runs it.
function startCatChildDrag(e, cat, child, chipEl, paneId, anchor, close) {
  if (e.button !== 0) return;
  if (e.target.closest('.chip-del')) return; // let delete handle it
  const startX = e.clientX, startY = e.clientY;
  const bar = anchor.closest('.launcher-bar');
  const list = chipEl.closest('.cat-children');
  let dragging = false;
  let ghost = null;
  let dropCatEl = null;

  function clearHL() {
    if (dropCatEl) dropCatEl.classList.remove('chip-drop-into');
    dropCatEl = null;
    if (bar) bar.classList.remove('bar-drop-active');
  }
  function move(ev) {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      const r0 = chipEl.getBoundingClientRect();
      chipEl.classList.add('chip-dragging');
      ghost = chipEl.cloneNode(true);
      ghost.querySelectorAll('.chip-del').forEach((d) => d.remove());
      ghost.classList.add('chip-ghost');
      // keep the dragged chip its real size (the popup chip is width:100% -> would
      // otherwise stretch the fixed-position ghost to the full screen width)
      ghost.style.width = r0.width + 'px';
      document.body.appendChild(ghost);
    }
    ghost.style.left = (ev.clientX + 10) + 'px';
    ghost.style.top = (ev.clientY + 10) + 'px';
    clearHL();
    // over another category chip in the bar? -> move between categories
    if (bar) {
      const overCat = [...bar.querySelectorAll('.launcher-chip.chip-category')]
        .find((c) => c.dataset.lid !== cat.id && pointInRect(ev, c));
      if (overCat) { dropCatEl = overCat; dropCatEl.classList.add('chip-drop-into'); return; }
    }
    // inside the popup list -> live reorder among the category's commands
    if (list && pointInRect(ev, list)) {
      const sibs = [...list.querySelectorAll('.cat-child-chip:not(.chip-dragging)')];
      let next = null;
      for (const s of sibs) {
        const r = s.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { next = s; break; }
      }
      if (next) list.insertBefore(chipEl, next);
      else list.appendChild(chipEl);
      return;
    }
    // over the bar in general -> will drop out to top level
    if (bar && pointInRect(ev, bar)) bar.classList.add('bar-drop-active');
  }
  function up(ev) {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (ghost) ghost.remove();
    chipEl.classList.remove('chip-dragging');
    if (!dragging) { clearHL(); close(); runLauncher(child, paneId); return; }

    const destCatId = dropCatEl ? dropCatEl.dataset.lid : null;
    const overBar = bar && pointInRect(ev, bar);
    clearHL();

    if (destCatId) {
      // move into another category
      cat.children = (cat.children || []).filter((x) => x.id !== child.id);
      const dest = launchers.find((l) => l.id === destCatId && l.type === 'category');
      if (dest) { dest.children = dest.children || []; dest.children.push(child); }
      saveLaunchers(); close(); render(); return;
    }
    if (overBar) {
      // pop out to the top-level bar, inserted at the drop position
      cat.children = (cat.children || []).filter((x) => x.id !== child.id);
      const chips = [...bar.querySelectorAll('.launcher-chip')];
      let insertIdx = launchers.length;
      for (const c of chips) {
        const r = c.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          const idx = launchers.findIndex((l) => l.id === c.dataset.lid);
          if (idx >= 0) { insertIdx = idx; break; }
        }
      }
      launchers.splice(insertIdx, 0, { ...child, type: 'command' });
      saveLaunchers(); close(); render(); return;
    }
    if (list && pointInRect(ev, list)) {
      // reorder within the category, following the live DOM order
      const order = [...list.querySelectorAll('.cat-child-chip')].map((c) => c.dataset.lid);
      cat.children.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveLaunchers(); close(); openCategoryMenu(cat, paneId, anchor); return;
    }
    // dropped nowhere useful -> keep the popup open, unchanged
    close(); openCategoryMenu(cat, paneId, anchor);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function focusTerminal(id) {
  const v = views.get(id);
  if (v && v.opened) { try { v.term.focus(); } catch { /* */ } }
}

function updateFocusClasses() {
  document.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('focused', p.dataset.id === focusedId);
  });
}

// ---------------- pane actions ----------------

function addPane() {
  if (fullscreenId) fullscreenId = null;
  const leaf = makeLeaf();
  if (!root) {
    root = leaf;
    focusedId = leaf.id;
    render();
    return;
  }
  const target = findLeaf(focusedId) || firstLeaf(root);
  splitTarget(target, leaf, 'right');
  focusedId = leaf.id;
  render();
}

// Open a web page in a new browser pane (split off the focused one). On the phone
// (remote) only localhost is supported, in an <iframe> served through a per-port tunnel
// (a real browser tab there can't reach the PC's localhost, and arbitrary sites can't be
// iframed). Non-local URLs on the phone just show a hint instead of spawning a Chrome tab.
function openBrowserPane(url, name) {
  if (isRemote) return openRemoteLocalhostPane(url, name);
  if (fullscreenId) fullscreenId = null;
  const leaf = makeBrowserLeaf(url);
  if (name) leaf.name = name;
  if (!root) {
    root = leaf;
    focusedId = leaf.id;
    render();
    return;
  }
  const target = findLeaf(focusedId) || firstLeaf(root);
  splitTarget(target, leaf, 'right');
  focusedId = leaf.id;
  render();
}

function openRemoteLocalhostPane(rawUrl, name) {
  const parsed = parseLocalUrl(rawUrl);
  if (!parsed) { showInfoToast('Στο κινητό το browser pane ανοίγει μόνο localhost διευθύνσεις.'); return; }
  if (fullscreenId) fullscreenId = null;
  const leaf = makeBrowserLeaf('about:blank');
  leaf.localUrl = parsed.full;
  leaf.name = name || ('localhost:' + parsed.port);
  if (!root) { root = leaf; focusedId = leaf.id; }
  else { splitTarget(findLeaf(focusedId) || firstLeaf(root), leaf, 'right'); focusedId = leaf.id; }
  render();
  const v = views.get(leaf.id);
  setSlotMsg(v, 'Σύνδεση μέσω tunnel…');
  window.termi.exposePort(parsed.port).then((res) => {
    const vv = views.get(leaf.id);
    if (!vv) return;
    if (!res || !res.ok || !res.value || !res.value.url) { setSlotMsg(vv, 'Αποτυχία σύνδεσης στη θύρα ' + parsed.port); return; }
    leaf.url = res.value.url.replace(/\/$/, '') + parsed.path;
    try { vv.wv.src = leaf.url; } catch { /* */ }
  });
}

// Accept a bare port (3000), host:port, or full URL from the +browser localhost box.
function openLocalhostFromInput(val) {
  const parsed = toLocalUrl(val);
  if (!parsed) { showInfoToast('Δώσε μια θύρα ή μια localhost διεύθυνση.'); return; }
  openBrowserPane(parsed.full);
}

// A small, self-dismissing toast centered at the bottom (reuses .url-toast styling).
function showInfoToast(msg) {
  const t = document.createElement('div');
  t.className = 'url-toast';
  t.style.left = '50%';
  t.style.top = (window.innerHeight - 24) + 'px';
  t.innerHTML = '<div class="ut-msg"></div>';
  t.querySelector('.ut-msg').textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function closePane(leaf) {
  // A minimized pane isn't in the layout tree — just drop it from the tray and kill its view.
  const mi = minimized.indexOf(leaf);
  if (mi !== -1) {
    minimized.splice(mi, 1);
    destroyView(leaf.id);
    renderMinimizedTray();
    return;
  }
  if (peekPaneId === leaf.id) peekPaneId = null;
  if (fullscreenId === leaf.id) fullscreenId = null;
  destroyView(leaf.id);
  if (root === leaf) {
    // closing the last pane -> empty workspace
    root = null;
    focusedId = null;
    render();
    return;
  }
  removeLeaf(leaf);
  if (focusedId === leaf.id) focusedId = firstLeaf(root).id;
  render();
}

// ---------------- minimize / restore ----------------

// Pull a pane off the layout but keep it ALIVE (no destroyView -> the terminal/pty, editor,
// or webview keeps running in the views Map). It moves into the centered "Ελαχιστοποιημένα"
// header tray; restorePane() splits it back in later, re-attaching the same session.
function minimizePane(leaf) {
  if (minimized.includes(leaf)) return;
  if (peekPaneId === leaf.id) peekPaneId = null;
  if (fullscreenId === leaf.id) fullscreenId = null;
  if (root === leaf) {
    root = null;            // it was the only pane -> empty workspace while it's parked
  } else {
    removeLeaf(leaf);
  }
  minimized.push(leaf);
  if (focusedId === leaf.id) focusedId = root ? firstLeaf(root).id : null;
  render();
  renderMinimizedTray();
}

// Bring a minimized pane back: split it off the focused pane (or make it the root if the
// workspace is empty) and focus it. The view is reused as-is, so the session is intact.
function restorePane(leaf) {
  const idx = minimized.indexOf(leaf);
  if (idx === -1) return;
  minimized.splice(idx, 1);
  if (fullscreenId) fullscreenId = null;
  if (!root) {
    root = leaf;
  } else {
    splitTarget(findLeaf(focusedId) || firstLeaf(root), leaf, 'right');
  }
  focusedId = leaf.id;
  render();
  renderMinimizedTray();
}

// ---------------- per-pane bar auto-hide (browser panes) ----------------

// Toggle whether THIS pane hides its own bar. When hidden the bar collapses (the page area
// grows) and reappears only while peeking. Nothing outside this pane is affected.
function toggleBarHidden(leaf) {
  leaf.barHidden = !leaf.barHidden;
  if (!leaf.barHidden && peekPaneId === leaf.id) peekPaneId = null;
  render();   // rebuilds the bar (icon flips) + re-runs layoutWebviews (positions the hot-zone)
}

function paneEl(id) {
  return id ? document.querySelector('.pane[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"]') : null;
}

// While a pane's bar is peeking we disable its webview's pointer-events. Two wins: (1) the
// guest no longer swallows mousemove, so the move-based hide stays reliable (no stick); and
// (2) as the bar expands and pushes the webview down, the cursor can sweep over the (still-
// repositioning) guest to reach the bar without a transient mouseenter collapsing the peek.
// During a peek you use the BAR, not the page, so this is invisible in practice.
function setPaneWebviewPE(id, val) {
  const v = views.get(id);
  if (v && v.wv) v.wv.style.pointerEvents = val;
}

// Reveal a hidden pane's bar (peek). Only one pane peeks at a time.
function setBarPeek(id) {
  if (peekPaneId === id) return;
  if (peekPaneId) {
    const prev = paneEl(peekPaneId);
    if (prev) prev.classList.remove('bar-peek');
    setPaneWebviewPE(peekPaneId, '');
  }
  peekPaneId = id;
  const p = paneEl(id);
  if (p) p.classList.add('bar-peek');
  setPaneWebviewPE(id, 'none');
  scheduleWebviewLayout();
}

function clearBarPeek() {
  if (!peekPaneId) return;
  const p = paneEl(peekPaneId);
  if (p) p.classList.remove('bar-peek');
  setPaneWebviewPE(peekPaneId, '');
  peekPaneId = null;
  scheduleWebviewLayout();
}

// Collapse any peeked header (app header AND a peeking pane bar). Used as the reliable hide
// signal for the cases the document `mousemove` can't see: the cursor moving INTO a
// <webview>/<iframe> (whose guest swallows mousemove so the move-based hide never fires) or
// leaving the window entirely. Without these the peek would "stick" until you re-entered
// host DOM — exactly the flaky behaviour we're fixing.
function collapsePeeks() {
  if (document.body.classList.contains('dragging')) return; // a pane drag keeps the bar up
  if (headerHideActive) document.body.classList.remove('header-peek');
  clearBarPeek();
}

// Sync the header tray button (hidden when nothing is minimized, otherwise shows the count).
function renderMinimizedTray() {
  const tray = document.getElementById('minimized-tray');
  if (!tray) return;
  if (!minimized.length) {
    if (minMenuClose) minMenuClose();   // tears down the dropdown + its document listeners
    tray.classList.add('hidden');
    return;
  }
  tray.classList.remove('hidden');
  const c = tray.querySelector('.min-count');
  if (c) c.textContent = minimized.length;
}

// Closer for the currently-open minimized dropdown (null when none) — lets the tray button
// toggle it shut on a second click while properly tearing down its document listeners.
let minMenuClose = null;

// Dropdown anchored to the tray button: one row per minimized pane (color dot + name);
// click restores it, ✕ closes it for good.
function openMinimizedMenu(anchor) {
  document.querySelectorAll('.browser-menu').forEach((m) => m.remove());
  if (!minimized.length) return;
  const menu = document.createElement('div');
  menu.className = 'browser-menu min-menu';

  minimized.slice().forEach((leaf) => {
    const it = document.createElement('div');
    it.className = 'bm-item';
    it.title = 'Επαναφορά';
    const dot = document.createElement('span');
    dot.className = 'min-dot';
    dot.style.background = leaf.color;
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = leaf.name || 'pane';
    const del = document.createElement('span');
    del.className = 'bm-del';
    del.textContent = '✕';
    del.title = 'Κλείσιμο';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      closePane(leaf);
      close();
      if (minimized.length) openMinimizedMenu(anchor);
    });
    it.append(dot, label, del);
    it.addEventListener('click', (e) => { e.stopPropagation(); close(); restorePane(leaf); });
    menu.appendChild(it);
  });

  document.body.appendChild(menu);
  anchor.classList.add('open');   // flips the chevron + lights the border while open
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';

  function close() { menu.remove(); anchor.classList.remove('open'); minMenuClose = null; document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', esc, true); }
  minMenuClose = close;
  function outside(e) { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); }
  function esc(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', esc, true); }, 0);
}

// ---------------- drag + snap zones ----------------

let currentDrop = null;
let zonesEl = null;

function startPaneDrag(e, leaf) {
  if (e.button !== 0) return;
  if (e.target.closest('button, input')) return;
  const startX = e.clientX, startY = e.clientY;
  let dragging = false;
  let ghost = null;

  function move(ev) {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging = true;
      document.body.classList.add('dragging');
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = leaf.name;
      overlay.appendChild(ghost);
    }
    ghost.style.left = (ev.clientX + 12) + 'px';
    ghost.style.top = (ev.clientY + 14) + 'px';
    updateDropTarget(ev);
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging');
    if (ghost) ghost.remove();
    clearDropZones();
    if (dragging && currentDrop) performDrop(leaf, currentDrop.targetId, currentDrop.zone);
    currentDrop = null;
    clearBarPeek();   // if this came from a hidden-bar pane, drop the peek + restore its webview pointer-events
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function updateDropTarget(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const pane = el && el.closest ? el.closest('.pane') : null;
  if (!pane) { clearDropZones(); currentDrop = null; return; }
  const rect = pane.getBoundingClientRect();
  const zone = computeZone(ev.clientX, ev.clientY, rect);
  showDropZones(rect, zone);
  currentDrop = { targetId: pane.dataset.id, zone };
}

function computeZone(x, y, rect) {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edge = 0.30;
  if (fx > edge && fx < 1 - edge && fy > edge && fy < 1 - edge) return 'center';
  const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return 'left';
  if (m === dr) return 'right';
  if (m === dt) return 'top';
  return 'bottom';
}

function showDropZones(rect, activeZone) {
  clearDropZones();
  zonesEl = document.createElement('div');
  zonesEl.className = 'drop-zones';
  zonesEl.style.left = rect.left + 'px';
  zonesEl.style.top = rect.top + 'px';
  zonesEl.style.width = rect.width + 'px';
  zonesEl.style.height = rect.height + 'px';
  const defs = {
    left:   { l: '0',   t: '0',   w: '40%',  h: '100%' },
    right:  { l: '60%', t: '0',   w: '40%',  h: '100%' },
    top:    { l: '0',   t: '0',   w: '100%', h: '40%' },
    bottom: { l: '0',   t: '60%', w: '100%', h: '40%' },
    center: { l: '30%', t: '30%', w: '40%',  h: '40%' },
  };
  for (const [zone, d] of Object.entries(defs)) {
    const z = document.createElement('div');
    z.className = 'drop-zone' + (zone === activeZone ? ' active' : '');
    z.style.left = d.l; z.style.top = d.t; z.style.width = d.w; z.style.height = d.h;
    zonesEl.appendChild(z);
  }
  overlay.appendChild(zonesEl);
}

function clearDropZones() {
  if (zonesEl) { zonesEl.remove(); zonesEl = null; }
}

function performDrop(dragged, targetId, zone) {
  const target = findLeaf(targetId);
  if (!target || target === dragged) { render(); return; }
  if (zone === 'center') {
    swapNodes(dragged, target);
  } else {
    removeLeaf(dragged);
    splitTarget(target, dragged, zone);
  }
  focusedId = dragged.id;
  render();
}

// ---------------- category popup (lists a category's commands) ----------------
// Anchored to a category chip: click a command to run it in this pane, ✕ to remove,
// or "＋ Προσθήκη εντολής" to add a new command straight into this category.
function openCategoryMenu(L, paneId, anchor) {
  document.querySelectorAll('.browser-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'browser-menu cat-menu';

  const children = L.children || (L.children = []);
  if (!children.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-head';
    empty.textContent = 'Κενή κατηγορία — σύρε εδώ ένα κουμπί ή πρόσθεσε εντολή';
    menu.appendChild(empty);
  }
  const list = document.createElement('div');
  list.className = 'cat-children';
  children.forEach((c) => {
    // commands render as colored chips (like the bar) and are draggable in/out
    const chip = document.createElement('button');
    chip.className = 'launcher-chip cat-child-chip';
    chip.dataset.lid = c.id;
    chip.style.borderColor = c.color || 'var(--border)';
    const tip = [];
    if (c.cwd) tip.push('📁 ' + c.cwd);
    if (c.command) tip.push('▸ ' + c.command);
    chip.title = tip.join('\n');

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = c.name;
    const del = document.createElement('span');
    del.className = 'chip-del';
    del.textContent = '✕';
    del.title = 'Διαγραφή εντολής';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      L.children = children.filter((x) => x.id !== c.id);
      saveLaunchers();
      close();
      render();
      openCategoryMenu(L, paneId, anchor);
    });
    chip.append(label, del);
    // pointerdown -> potential drag (out to bar / to another category); a plain click runs it
    chip.addEventListener('pointerdown', (e) => startCatChildDrag(e, L, c, chip, paneId, anchor, close));
    list.appendChild(chip);
  });
  menu.appendChild(list);

  const sep = document.createElement('div'); sep.className = 'bm-sep'; menu.appendChild(sep);
  const add = document.createElement('div');
  add.className = 'bm-item bm-add';
  add.innerHTML = `<i class="codicon codicon-add"></i><span class="bm-label">Προσθήκη εντολής…</span>`;
  add.addEventListener('click', (e) => { e.stopPropagation(); close(); openLauncherModal({ categoryId: L.id }); });
  menu.appendChild(add);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';

  function close() { menu.remove(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', esc, true); }
  function outside(e) { if (!menu.contains(e.target) && e.target !== anchor) close(); }
  function esc(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', esc, true); }, 0);
}

// ---------------- launcher creation modal ----------------
// opts.categoryId (optional): create a command straight inside that category.
function openLauncherModal(opts = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const intoCat = opts.categoryId
    ? launchers.find((l) => l.type === 'category' && l.id === opts.categoryId)
    : null;
  const cats = launchers.filter((l) => l.type === 'category');

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h3>${intoCat ? 'Νέα εντολή στην κατηγορία «' + intoCat.name + '»' : 'Νέο κουμπί'}</h3>
    <div class="m-seg" ${intoCat ? 'style="display:none"' : ''}>
      <button type="button" class="m-seg-btn active" data-type="command">Εντολή</button>
      <button type="button" class="m-seg-btn" data-type="category">Κατηγορία</button>
    </div>
    <label>Όνομα<input type="text" class="m-name" placeholder="π.χ. Project / Build" spellcheck="false"></label>
    <label class="m-cat-row" ${intoCat || !cats.length ? 'style="display:none"' : ''}>Κατηγορία
      <select class="m-cat">
        <option value="">(Καμία — στη μπάρα)</option>
        ${cats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}
      </select>
    </label>
    <label class="m-cwd-row">Διαδρομή (προαιρετική)
      <span class="m-row">
        <input type="text" class="m-cwd" placeholder="C:\\..." spellcheck="false">
        <button type="button" class="m-pick" title="Επιλογή φακέλου">📁</button>
      </span>
    </label>
    <label class="m-cmd-row">Εντολή (προαιρετική)<input type="text" class="m-cmd" placeholder="π.χ. npm run dev" spellcheck="false"></label>
    <label class="m-color-row">Χρώμα<input type="color" class="m-color" value="#58a6ff"></label>
    <div class="m-hint m-hint-cmd">Άφησε την εντολή κενή για κουμπί μόνο-διαδρομής (κάνει <code>cd</code>).</div>
    <div class="m-hint m-hint-cat" style="display:none">Η κατηγορία είναι ένα κουμπί που ανοίγει pop-up με τις εντολές σου.</div>
    <div class="m-actions">
      <button type="button" class="m-cancel">Άκυρο</button>
      <button type="button" class="m-save">Αποθήκευση</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const nameI = modal.querySelector('.m-name');
  const cwdI = modal.querySelector('.m-cwd');
  const cmdI = modal.querySelector('.m-cmd');
  const colorI = modal.querySelector('.m-color');
  const catSel = modal.querySelector('.m-cat');
  if (intoCat) catSel.value = intoCat.id;

  // type toggle (Εντολή / Κατηγορία) — categories only need name + color
  let kind = 'command';
  const cmdOnlyRows = ['.m-cat-row', '.m-cwd-row', '.m-cmd-row', '.m-hint-cmd'];
  function setKind(k) {
    kind = k;
    modal.querySelectorAll('.m-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === k));
    const isCmd = k === 'command';
    cmdOnlyRows.forEach((sel) => {
      const el = modal.querySelector(sel);
      if (!el) return;
      // keep the category dropdown hidden when there are no categories to pick
      if (sel === '.m-cat-row' && (!cats.length || intoCat)) { el.style.display = 'none'; return; }
      el.style.display = isCmd ? '' : 'none';
    });
    modal.querySelector('.m-hint-cat').style.display = isCmd ? 'none' : '';
  }
  modal.querySelectorAll('.m-seg-btn').forEach((b) => {
    b.addEventListener('click', () => setKind(b.dataset.type));
  });

  nameI.focus();

  function close() { backdrop.remove(); }

  modal.querySelector('.m-pick').addEventListener('click', async () => {
    const p = await window.termi.pickFolder(cwdI.value || null);
    if (p) cwdI.value = p;
  });
  modal.querySelector('.m-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  window.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); window.removeEventListener('keydown', esc); }
  });

  function save() {
    const name = nameI.value.trim();
    if (!name) { nameI.focus(); return; }

    if (kind === 'category') {
      launchers.push({ id: 'l' + Date.now(), type: 'category', name, color: colorI.value, children: [] });
      saveLaunchers();
      close();
      render();
      return;
    }

    const cwd = cwdI.value.trim();
    const command = cmdI.value.trim();
    if (!cwd && !command) { cwdI.focus(); return; }
    const cmd = { id: 'l' + Date.now(), name, cwd, command, color: colorI.value };
    const targetId = intoCat ? intoCat.id : catSel.value;
    const cat = targetId && launchers.find((l) => l.type === 'category' && l.id === targetId);
    if (cat) {
      cat.children = cat.children || [];
      cat.children.push(cmd);
    } else {
      launchers.push({ ...cmd, type: 'command' });
    }
    saveLaunchers();
    close();
    render();
  }
  modal.querySelector('.m-save').addEventListener('click', save);
  modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ---------------- web browser: + browser menu + saved apps ----------------

// Dropdown anchored to the "+ browser" toolbar button: a blank tab, your saved apps,
// and an "add app" entry. Clicking an app opens it in a pane (or a tab on the phone).
function openBrowserMenu(anchor) {
  document.querySelectorAll('.browser-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'browser-menu';

  const addItem = (label, icon, onClick, opts = {}) => {
    const it = document.createElement('div');
    it.className = 'bm-item' + (opts.cls ? ' ' + opts.cls : '');
    it.innerHTML = `<i class="codicon codicon-${icon}"></i><span class="bm-label"></span>`;
    it.querySelector('.bm-label').textContent = label;
    if (opts.title) it.title = opts.title;
    it.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    if (opts.onDelete) {
      const del = document.createElement('span');
      del.className = 'bm-del'; del.textContent = '✕'; del.title = 'Διαγραφή';
      del.addEventListener('click', (e) => { e.stopPropagation(); opts.onDelete(); });
      it.appendChild(del);
    }
    (opts.parent || menu).appendChild(it);
    return it;
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'bm-sep'; menu.appendChild(s); };

  if (isRemote) {
    // phone: browser panes are localhost-only (served through a tunnel), so the entry
    // point is a small box to type a port/URL — no blank tab, no arbitrary saved sites.
    const hdr0 = document.createElement('div');
    hdr0.className = 'bm-head';
    hdr0.textContent = 'Προεπισκόπηση localhost σε pane:';
    menu.appendChild(hdr0);
    const row = document.createElement('div');
    row.className = 'bm-item';
    const inp = document.createElement('input');
    inp.className = 'wv-url';
    inp.style.width = '100%';
    inp.placeholder = 'θύρα (π.χ. 3000) ή URL';
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const val = inp.value; close(); openLocalhostFromInput(val); } });
    row.appendChild(inp);
    menu.appendChild(row);
  } else {
    addItem('Νέα κενή καρτέλα', 'globe', () => { close(); openBrowserPane(); });
    if (webApps.length) {
      sep();
      const appsBox = document.createElement('div');
      appsBox.className = 'bm-apps';
      menu.appendChild(appsBox);
      renderApps(appsBox, anchor, close);
    }
    sep();
    addItem('Προσθήκη εφαρμογής…', 'add', () => { close(); openWebAppModal({}); }, { cls: 'bm-add' });
  }

  // settings (in-panel, no extra popup): how detected local URLs should open. Collapsed into
  // a toggle so the menu stays compact. On the phone "external" isn't possible (no reach to
  // the PC's localhost), so it's hidden.
  sep();
  const setHead = document.createElement('div');
  setHead.className = 'bm-item bm-collapse-head';
  setHead.innerHTML = '<i class="codicon codicon-chevron-right"></i><span class="bm-label">Τοπικά URL ανοίγουν</span>';
  const setBody = document.createElement('div');
  setBody.className = 'bm-collapse-body';
  setHead.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = setBody.classList.toggle('open');
    setHead.querySelector('.codicon').className = 'codicon codicon-chevron-' + (open ? 'down' : 'right');
  });
  menu.appendChild(setHead);
  menu.appendChild(setBody);
  const optLabels = { ask: 'Ερώτηση κάθε φορά', pane: 'Πάντα σε pane', external: 'Πάντα στον browser' };
  (isRemote ? ['ask', 'pane'] : ['ask', 'pane', 'external']).forEach((opt) => {
    const it = addItem(optLabels[opt], urlAction === opt ? 'circle-filled' : 'circle-outline', () => {
      urlAction = opt; saveUrlAction();
      // repaint the radios in place (no menu rebuild -> no listener churn)
      setBody.querySelectorAll('.bm-item[data-opt]').forEach((row) => {
        const ic = row.querySelector('.codicon');
        if (ic) ic.className = 'codicon codicon-' + (row.dataset.opt === urlAction ? 'circle-filled' : 'circle-outline');
      });
    }, { parent: setBody });
    it.dataset.opt = opt;
  });

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';

  function close() { menu.remove(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', esc, true); }
  function outside(e) { if (!menu.contains(e.target) && e.target !== anchor) close(); }
  function esc(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', esc, true); }, 0);
}

// Render saved-app rows into `container`: auto-fetched favicon, click opens the app, ✕ deletes,
// drag (pointer-based) reorders. `close` shuts the parent menu when an app is opened.
function renderApps(container, anchor, close) {
  container.innerHTML = '';
  webApps.forEach((app) => {
    const it = document.createElement('div');
    it.className = 'bm-item bm-app';
    it.dataset.appId = app.id;
    it.title = app.url;

    const fav = document.createElement('img');
    fav.className = 'bm-favicon';
    fav.alt = '';
    const fu = faviconUrl(app.url);
    if (fu) fav.src = fu;
    // offline / no favicon -> swap the <img> for a globe codicon
    fav.addEventListener('error', () => {
      const icon = document.createElement('i');
      icon.className = 'codicon codicon-globe bm-favicon';
      fav.replaceWith(icon);
    });

    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = app.name;

    const del = document.createElement('span');
    del.className = 'bm-del'; del.textContent = '✕'; del.title = 'Διαγραφή';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      webApps = webApps.filter((a) => a.id !== app.id);
      saveWebApps();
      if (webApps.length) renderApps(container, anchor, close);
      else { close(); openBrowserMenu(anchor); }   // last app gone -> rebuild (drops the section)
    });

    it.append(fav, label, del);
    attachAppRowPointer(it, app, container, close);
    container.appendChild(it);
  });
}

// Pointer handling for a saved-app row: a small movement threshold distinguishes a click
// (opens the app) from a drag (reorders the list live; the new order persists on drop).
function attachAppRowPointer(rowEl, app, container, close) {
  rowEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.bm-del')) return;   // delete button has its own handler
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    rowEl.setPointerCapture(e.pointerId);

    function move(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5 && Math.abs(ev.clientX - startX) < 5) return;
        dragging = true;
        rowEl.classList.add('bm-app-dragging');
      }
      const others = [...container.querySelectorAll('.bm-app')].filter((r) => r !== rowEl);
      const after = others.find((r) => {
        const rect = r.getBoundingClientRect();
        return ev.clientY < rect.top + rect.height / 2;
      });
      if (after) container.insertBefore(rowEl, after);
      else container.appendChild(rowEl);
    }
    function up() {
      try { rowEl.releasePointerCapture(e.pointerId); } catch { /* */ }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragging) {
        rowEl.classList.remove('bm-app-dragging');
        const ids = [...container.querySelectorAll('.bm-app')].map((r) => r.dataset.appId);
        webApps = ids.map((id) => webApps.find((a) => a.id === id)).filter(Boolean);
        saveWebApps();
      } else {
        close();
        openBrowserPane(app.url, app.name);
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

// Modal to define/save a web app (name + URL). Reuses the launcher modal styling.
function openWebAppModal(prefill) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h3>Αποθήκευση εφαρμογής</h3>
    <label>Όνομα<input type="text" class="m-name" placeholder="π.χ. YouTube" spellcheck="false"></label>
    <label>Διεύθυνση (URL)<input type="text" class="m-url" placeholder="https://..." spellcheck="false"></label>
    <div class="m-hint">Θα γίνει επαναχρησιμοποιήσιμο κουμπί στο μενού «+ browser».</div>
    <div class="m-actions">
      <button type="button" class="m-cancel">Άκυρο</button>
      <button type="button" class="m-save">Αποθήκευση</button>
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const nameI = modal.querySelector('.m-name');
  const urlI = modal.querySelector('.m-url');
  nameI.value = prefill.name || '';
  urlI.value = prefill.url || '';
  (nameI.value ? urlI : nameI).focus();

  function close() { backdrop.remove(); window.removeEventListener('keydown', esc); }
  function esc(e) { if (e.key === 'Escape') close(); }
  window.addEventListener('keydown', esc);
  modal.querySelector('.m-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  function save() {
    const name = nameI.value.trim();
    if (!name) { nameI.focus(); return; }
    if (!urlI.value.trim()) { urlI.focus(); return; }
    const url = resolveAddress(urlI.value);
    webApps.push({ id: 'w' + Date.now(), name, url });
    saveWebApps();
    close();
  }
  modal.querySelector('.m-save').addEventListener('click', save);
  modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ★ in a browser pane bar -> save its current page as a reusable app.
function saveCurrentAsApp(leaf) {
  openWebAppModal({ name: leaf.name && leaf.name !== 'Browser' ? leaf.name : '', url: leaf.url || '' });
}

// ---------------- file explorer sidebar ----------------

const sidebarEl = document.getElementById('sidebar');
const treeEl = document.getElementById('tree');
let rootPath = localStorage.getItem('termi.root') || null;
const expandedDirs = new Set();
let currentDir = rootPath; // target dir for new file/folder

// Per-folder name color (path -> hex). Persisted.
let folderColors = (() => {
  try { return JSON.parse(localStorage.getItem('termi.folderColors') || '{}'); }
  catch { return {}; }
})();
function saveFolderColors() { localStorage.setItem('termi.folderColors', JSON.stringify(folderColors)); }

// Per-item notes (path -> text). Persisted. Works for both files and folders.
let notesData = (() => {
  try { return JSON.parse(localStorage.getItem('termi.notes') || '{}'); }
  catch { return {}; }
})();
function saveNotes() { localStorage.setItem('termi.notes', JSON.stringify(notesData)); }
function remapNotes(oldP, newP) {
  const sep = oldP.includes('\\') ? '\\' : '/';
  const next = {};
  let changed = false;
  for (const [p, t] of Object.entries(notesData)) {
    if (p === oldP || p.startsWith(oldP + sep)) { next[newP + p.slice(oldP.length)] = t; changed = true; }
    else next[p] = t;
  }
  if (changed) { notesData = next; saveNotes(); }
}
// Drop notes + color for a deleted path and all its descendants.
function purgePathData(p) {
  const sep = p.includes('\\') ? '\\' : '/';
  let dirty = false;
  for (const store of [notesData, folderColors]) {
    for (const k of Object.keys(store)) {
      if (k === p || k.startsWith(p + sep)) { delete store[k]; dirty = true; }
    }
  }
  if (dirty) { saveNotes(); saveFolderColors(); }
}
// First few non-empty lines of a note, for the hover tooltip.
function notePreview(text, maxLines = 3) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? head + '\n…' : head;
}

let noteTipEl = null;
function showNoteTip(row, text) {
  if (!text) return;
  hideNoteTip();
  noteTipEl = document.createElement('div');
  noteTipEl.className = 'note-tip';
  noteTipEl.textContent = text;
  document.body.appendChild(noteTipEl);
  const r = row.getBoundingClientRect();
  // place to the right of the row, clamped to the viewport
  let left = r.right + 8;
  let top = r.top;
  const tw = noteTipEl.offsetWidth, th = noteTipEl.offsetHeight;
  if (left + tw > window.innerWidth - 8) left = Math.max(8, r.left - tw - 8);
  if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
  noteTipEl.style.left = left + 'px';
  noteTipEl.style.top = top + 'px';
}
function hideNoteTip() { if (noteTipEl) { noteTipEl.remove(); noteTipEl = null; } }
// When a folder is moved/renamed, carry its color (and its descendants') to the new path.
function remapColors(oldP, newP) {
  const sep = oldP.includes('\\') ? '\\' : '/';
  const next = {};
  let changed = false;
  for (const [p, c] of Object.entries(folderColors)) {
    if (p === oldP || p.startsWith(oldP + sep)) { next[newP + p.slice(oldP.length)] = c; changed = true; }
    else next[p] = c;
  }
  if (changed) { folderColors = next; saveFolderColors(); }
}

let activeSidebarView = 'explorer';
const explorerViewEl = document.getElementById('explorer-view');
const scmViewEl = document.getElementById('scm-view');

function setSidebarView(v) {
  activeSidebarView = v;
  explorerViewEl.classList.toggle('hidden', v !== 'explorer');
  scmViewEl.classList.toggle('hidden', v !== 'scm');
  if (v === 'scm') refreshScm();
}
function showSidebarView(v) {
  sidebarEl.classList.remove('hidden');
  setSidebarView(v);
  visibleLeafIds().forEach(scheduleFit);
}
function toggleSidebarView(v) {
  if (sidebarEl.classList.contains('hidden') || activeSidebarView !== v) showSidebarView(v);
  else { sidebarEl.classList.add('hidden'); visibleLeafIds().forEach(scheduleFit); }
}

async function pickRoot() {
  const p = await window.termi.pickFolder(rootPath);
  if (!p) return;
  rootPath = p;
  currentDir = p;
  localStorage.setItem('termi.root', p);
  expandedDirs.clear();
  sidebarEl.classList.remove('hidden');
  window.termi.watchDir(p);
  await renderTree();
  updateScmBadge();
  if (activeSidebarView === 'scm') refreshScm();
  visibleLeafIds().forEach(scheduleFit);
}

async function renderTree() {
  const prevScroll = treeEl.scrollTop;
  // Build the whole tree off-DOM, then swap it in atomically. Mutating treeEl
  // directly (empty + async re-append) made it visibly flicker/shake on refresh.
  const frag = document.createDocumentFragment();
  if (!rootPath) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Άνοιξε έναν φάκελο για να ξεκινήσεις.';
    frag.appendChild(empty);
    treeEl.replaceChildren(frag);
    return;
  }
  const name = document.createElement('div');
  name.className = 'tree-root-name';
  name.textContent = rootPath;
  name.title = rootPath;
  name.addEventListener('click', () => { currentDir = rootPath; highlightCurrentDir(); });
  name.addEventListener('dragover', (e) => {
    if (!draggedPaths.length || !draggedPaths.some((p) => canDrop(p, rootPath))) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(name);
  });
  name.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    moveItems(draggedPaths, rootPath);
  });
  frag.appendChild(name);
  await renderChildren(frag, rootPath, 0);
  treeEl.replaceChildren(frag); // single atomic swap — no empty intermediate state
  highlightCurrentDir();
  updateSelectionClasses();
  treeEl.scrollTop = prevScroll; // keep scroll position stable across rebuilds
}

async function renderChildren(container, dir, depth) {
  const entries = await window.termi.listDir(dir);
  for (const ent of entries) container.appendChild(await makeTreeRow(ent, depth));
}

async function makeTreeRow(ent, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tree-row ' + (ent.isDir ? 'is-dir' : 'is-file');
  row.dataset.path = ent.path;
  row.style.paddingLeft = (depth * 14 + 6) + 'px';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = ent.name;
  if (ent.isDir && folderColors[ent.path]) label.style.color = folderColors[ent.path];

  // Notes: dot indicator + brief hover tooltip (first 2-3 lines).
  if (notesData[ent.path]) {
    row.classList.add('has-note');
    row.addEventListener('mouseenter', () => showNoteTip(row, notePreview(notesData[ent.path])));
    row.addEventListener('mouseleave', hideNoteTip);
  }

  function plainSelect() {
    selectedPaths.clear();
    selectedPaths.add(ent.path);
    lastClickedPath = ent.path;
    updateSelectionClasses();
  }

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selectedPaths.has(ent.path)) plainSelect();
    openTreeContextMenu(e, ent);
  });

  // --- drag & drop to move (supports multi-selection) ---
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    if (!selectedPaths.has(ent.path)) plainSelect();
    draggedPaths = [...selectedPaths];
    draggedPath = ent.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ent.path);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    clearDropTarget();
    draggedPaths = []; draggedPath = null;
  });
  const destFor = () => (ent.isDir ? ent.path : parentDir(ent.path));
  row.addEventListener('dragover', (e) => {
    const dest = destFor();
    if (!draggedPaths.length || !draggedPaths.some((p) => canDrop(p, dest))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(row);
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    moveItems(draggedPaths, destFor());
  });

  let defaultAction = null;

  if (ent.isDir) {
    const isOpen = expandedDirs.has(ent.path);
    const twisty = makeIcon(isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right');
    twisty.classList.add('tree-twisty');
    row.append(twisty, label);
    wrap.appendChild(row);

    const kids = document.createElement('div');
    kids.className = 'tree-kids';
    kids.style.display = isOpen ? 'block' : 'none';
    wrap.appendChild(kids);
    if (isOpen) { kids.dataset.loaded = '1'; await renderChildren(kids, ent.path, depth + 1); }

    defaultAction = async () => {
      currentDir = ent.path;
      if (expandedDirs.has(ent.path)) {
        expandedDirs.delete(ent.path);
        kids.style.display = 'none';
        twisty.className = 'codicon codicon-chevron-right tree-twisty';
      } else {
        expandedDirs.add(ent.path);
        twisty.className = 'codicon codicon-chevron-down tree-twisty';
        kids.style.display = 'block';
        if (!kids.dataset.loaded) { kids.dataset.loaded = '1'; await renderChildren(kids, ent.path, depth + 1); }
      }
      highlightCurrentDir();
    };
  } else {
    const spacer = makeIcon('codicon-blank');
    spacer.classList.add('tree-twisty');
    const ficon = makeIcon(fileIconClass(ent.name));
    ficon.classList.add('tree-ficon');
    row.append(spacer, ficon, label);
    wrap.appendChild(row);

    defaultAction = () => { currentDir = parentDir(ent.path); highlightCurrentDir(); openFile(ent.path); };
  }

  row.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (selectedPaths.has(ent.path)) selectedPaths.delete(ent.path);
      else selectedPaths.add(ent.path);
      lastClickedPath = ent.path;
      updateSelectionClasses();
      return; // selection only, no expand/open
    }
    if (e.shiftKey && lastClickedPath) {
      selectRange(lastClickedPath, ent.path);
      updateSelectionClasses();
      return;
    }
    plainSelect();
    if (defaultAction) defaultAction();
  });

  return wrap;
}

function parentDir(p) { return p.replace(/[\\/][^\\/]*$/, ''); }
function joinPath(dir, name) { return dir + (dir.includes('\\') ? '\\' : '/') + name; }
// Quote a path for the shell prompt only when it needs it (spaces/special chars).
function quoteForShell(p) { return /[\s'"&()$`;,]/.test(p) ? `"${p.replace(/"/g, '`"')}"` : p; }

const FILE_ICONS = {
  js: 'file-code', mjs: 'file-code', cjs: 'file-code', jsx: 'file-code',
  ts: 'file-code', tsx: 'file-code', html: 'file-code', htm: 'file-code',
  css: 'file-code', scss: 'file-code', less: 'file-code', py: 'file-code',
  java: 'file-code', c: 'file-code', h: 'file-code', cpp: 'file-code',
  cs: 'file-code', go: 'file-code', rs: 'file-code', rb: 'file-code',
  php: 'file-code', vue: 'file-code', svelte: 'file-code',
  json: 'json', md: 'markdown', markdown: 'markdown',
  csv: 'table', txt: 'file-text', log: 'output',
  sh: 'terminal', bash: 'terminal', ps1: 'terminal', bat: 'terminal', cmd: 'terminal',
  png: 'file-media', jpg: 'file-media', jpeg: 'file-media', gif: 'file-media',
  svg: 'file-media', webp: 'file-media', ico: 'file-media', mp4: 'file-media', mp3: 'file-media',
  zip: 'file-zip', rar: 'file-zip', '7z': 'file-zip', gz: 'file-zip', tar: 'file-zip',
  pdf: 'file-pdf',
  yml: 'settings-gear', yaml: 'settings-gear', toml: 'settings-gear',
  ini: 'settings-gear', env: 'settings-gear', conf: 'settings-gear',
  sql: 'database', db: 'database', sqlite: 'database',
};
function fileIconClass(name) { return 'codicon-' + (FILE_ICONS[extOf(name)] || 'file'); }

function makeIcon(cls) {
  const i = document.createElement('i');
  i.className = 'codicon ' + cls;
  return i;
}

function highlightCurrentDir() {
  treeEl.querySelectorAll('.curdir').forEach((r) => r.classList.remove('curdir'));
  if (!currentDir) return;
  if (currentDir === rootPath) {
    const rn = treeEl.querySelector('.tree-root-name');
    if (rn) rn.classList.add('curdir');
  }
  treeEl.querySelectorAll('.tree-row').forEach((r) => { if (r.dataset.path === currentDir) r.classList.add('curdir'); });
}

// ---- file operations ----

async function newFileFlow() {
  const dir = currentDir || rootPath;
  if (!dir) return;
  const nm = await promptModal('Νέο αρχείο', 'untitled.txt');
  if (!nm) return;
  const res = await window.termi.createFile(dir, nm);
  if (!res.ok) { alertModal('Σφάλμα', res.error); return; }
  expandedDirs.add(dir);
  await renderTree();
  openFile(joinPath(dir, nm));
}

async function newFolderFlow() {
  const dir = currentDir || rootPath;
  if (!dir) return;
  const nm = await promptModal('Νέος φάκελος', 'new-folder');
  if (!nm) return;
  const res = await window.termi.mkdir(dir, nm);
  if (!res.ok) { alertModal('Σφάλμα', res.error); return; }
  expandedDirs.add(dir);
  await renderTree();
}

async function renameFlow(ent) {
  const nm = await promptModal('Μετονομασία', ent.name);
  if (!nm || nm === ent.name) return;
  const res = await window.termi.renamePath(ent.path, nm);
  if (!res.ok) { alertModal('Σφάλμα', res.error); return; }
  const newPath = joinPath(parentDir(ent.path), nm);
  remapColors(ent.path, newPath);
  remapNotes(ent.path, newPath);
  for (const [id, v] of views) {
    if (v.kind === 'editor' && v.filePath === ent.path) {
      v.filePath = newPath;
      const lf = findLeaf(id);
      if (lf) { lf.filePath = newPath; lf.name = basename(newPath); }
    }
  }
  await renderTree();
  render();
}

async function colorFlow(ent) {
  const chosen = await colorModal(folderColors[ent.path] || '');
  if (chosen === undefined) return; // cancelled
  if (chosen === null) delete folderColors[ent.path]; // reset to default
  else folderColors[ent.path] = chosen;
  saveFolderColors();
  await renderTree();
}

async function notesFlow(ent) {
  const result = await notesModal(ent.name, notesData[ent.path] || '');
  if (result === undefined) return; // cancelled
  if (result.trim()) notesData[ent.path] = result;
  else delete notesData[ent.path];
  saveNotes();
  await renderTree();
}

async function deleteFlow(ent) {
  const ok = await confirmModal('Διαγραφή', `Να διαγραφεί οριστικά "${ent.name}";`);
  if (!ok) return;
  const res = await window.termi.deletePath(ent.path);
  if (!res.ok) { alertModal('Σφάλμα', res.error); return; }
  expandedDirs.delete(ent.path);
  purgePathData(ent.path);
  await renderTree();
}

// ---- tree selection + drag & drop (move items) ----

let draggedPath = null;
let draggedPaths = [];
let dropTargetEl = null;
const selectedPaths = new Set();
let lastClickedPath = null;

function updateSelectionClasses() {
  treeEl.querySelectorAll('.tree-row').forEach((r) => {
    r.classList.toggle('selected', selectedPaths.has(r.dataset.path));
  });
}

function selectRange(fromPath, toPath) {
  const rows = [...treeEl.querySelectorAll('.tree-row')].map((r) => r.dataset.path);
  let i = rows.indexOf(fromPath), j = rows.indexOf(toPath);
  if (i < 0 || j < 0) { selectedPaths.add(toPath); return; }
  if (i > j) [i, j] = [j, i];
  selectedPaths.clear();
  for (let k = i; k <= j; k++) selectedPaths.add(rows[k]);
}

function canDrop(src, dest) {
  if (!src || !dest) return false;
  if (dest === src) return false;
  if (parentDir(src) === dest) return false;        // already in this folder
  const sep = src.includes('\\') ? '\\' : '/';
  if (dest === src || dest.startsWith(src + sep)) return false; // into itself/descendant
  return true;
}

function setDropTarget(el) {
  if (dropTargetEl === el) return;
  clearDropTarget();
  dropTargetEl = el;
  if (el) el.classList.add('drop-target');
}
function clearDropTarget() {
  if (dropTargetEl) dropTargetEl.classList.remove('drop-target');
  dropTargetEl = null;
}

function remapEditors(oldP, newP) {
  const sep = oldP.includes('\\') ? '\\' : '/';
  for (const [id, v] of views) {
    if (v.kind !== 'editor') continue;
    let np = null;
    if (v.filePath === oldP) np = newP;
    else if (v.filePath.startsWith(oldP + sep)) np = newP + v.filePath.slice(oldP.length);
    if (np) {
      v.filePath = np;
      const lf = findLeaf(id);
      if (lf) { lf.filePath = np; lf.name = basename(np); }
    }
  }
}

function remapExpanded(oldP, newP) {
  const sep = oldP.includes('\\') ? '\\' : '/';
  for (const p of [...expandedDirs]) {
    if (p === oldP || p.startsWith(oldP + sep)) {
      expandedDirs.delete(p);
      expandedDirs.add(newP + p.slice(oldP.length));
    }
  }
}

async function moveItems(paths, dest) {
  clearDropTarget();
  const movable = (paths || []).filter((p) => canDrop(p, dest));
  if (!movable.length) return;
  let firstErr = null;
  for (const src of movable) {
    const res = await window.termi.movePath(src, dest);
    if (!res.ok) { firstErr = firstErr || res.error; continue; }
    const newPath = joinPath(dest, basename(src));
    remapEditors(src, newPath);
    remapExpanded(src, newPath);
    remapColors(src, newPath);
    remapNotes(src, newPath);
  }
  expandedDirs.add(dest);
  selectedPaths.clear();
  draggedPaths = []; draggedPath = null;
  if (firstErr) alertModal('Σφάλμα μετακίνησης', firstErr);
  await renderTree();
  render();
}

async function deleteSelected() {
  const paths = [...selectedPaths];
  if (!paths.length) return;
  const ok = await confirmModal(
    'Διαγραφή',
    paths.length === 1 ? `Να διαγραφεί οριστικά "${basename(paths[0])}";`
      : `Να διαγραφούν οριστικά ${paths.length} στοιχεία;`
  );
  if (!ok) return;
  let firstErr = null;
  for (const p of paths) {
    const res = await window.termi.deletePath(p);
    if (!res.ok) { firstErr = firstErr || res.error; continue; }
    expandedDirs.delete(p);
    purgePathData(p);
  }
  selectedPaths.clear();
  if (firstErr) alertModal('Σφάλμα διαγραφής', firstErr);
  await renderTree();
}

// ---- tree context menu ----

let ctxMenuEl = null;
function closeContextMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }

function openTreeContextMenu(e, ent) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const multi = selectedPaths.size > 1;
  const items = [];
  if (!multi) {
    if (ent.isDir) {
      items.push(['📄 Νέο αρχείο', () => { currentDir = ent.path; expandedDirs.add(ent.path); newFileFlow(); }]);
      items.push(['📁 Νέος φάκελος', () => { currentDir = ent.path; expandedDirs.add(ent.path); newFolderFlow(); }]);
      items.push(['🎨 Χρώμα ονόματος', () => colorFlow(ent)]);
    } else {
      items.push(['↗ Άνοιγμα', () => openFile(ent.path)]);
    }
    items.push(['✎ Μετονομασία', () => renameFlow(ent)]);
    items.push([notesData[ent.path] ? '📝 Σημειώσεις •' : '📝 Σημειώσεις', () => notesFlow(ent)]);
  }
  items.push([multi ? `🗑 Διαγραφή (${selectedPaths.size})` : '🗑 Διαγραφή', () => deleteSelected()]);

  for (const [lbl, fn] of items) {
    const it = document.createElement('div');
    it.className = 'ctx-item';
    it.textContent = lbl;
    it.addEventListener('click', () => { closeContextMenu(); fn(); });
    menu.appendChild(it);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', function onDown(ev) {
    if (!menu.contains(ev.target)) closeContextMenu();
    else document.addEventListener('pointerdown', onDown, { once: true });
  }, { once: true }), 0);
  ctxMenuEl = menu;
}

// ---- generic modals ----

function promptModal(title, def) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-sm';
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3>
      <input type="text" class="p-input" spellcheck="false">
      <div class="m-actions"><button class="m-cancel">Άκυρο</button><button class="m-save">OK</button></div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const input = modal.querySelector('.p-input');
    input.value = def || '';
    input.focus(); input.select();
    function done(val) { backdrop.remove(); resolve(val); }
    modal.querySelector('.m-cancel').addEventListener('click', () => done(null));
    modal.querySelector('.m-save').addEventListener('click', () => done(input.value.trim() || null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
  });
}

function confirmModal(title, msg) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-sm';
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="m-hint">${escapeHtml(msg)}</div>
      <div class="m-actions"><button class="m-cancel">Άκυρο</button><button class="m-save m-danger">Διαγραφή</button></div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    function done(v) { backdrop.remove(); resolve(v); }
    modal.querySelector('.m-cancel').addEventListener('click', () => done(false));
    modal.querySelector('.m-save').addEventListener('click', () => done(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
  });
}

// Returns: a hex string (chosen), null (reset to default), or undefined (cancelled).
const FOLDER_SWATCHES = [
  '#58a6ff', '#3fb950', '#d29922', '#ff7b72', '#bc8cff',
  '#39c5cf', '#f778ba', '#ffa657', '#a5d6ff', '#7ee787',
];
function colorModal(current) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-sm';
    const swatches = FOLDER_SWATCHES.map((c) =>
      `<button class="sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
    modal.innerHTML = `<h3>Χρώμα ονόματος φακέλου</h3>
      <div class="sw-grid">${swatches}</div>
      <div class="sw-custom">
        <label>Προσαρμοσμένο <input type="color" class="sw-pick" value="${/^#[0-9a-f]{6}$/i.test(current) ? current : '#58a6ff'}"></label>
      </div>
      <div class="m-actions">
        <button class="m-cancel">Άκυρο</button>
        <button class="m-reset">Επαναφορά</button>
        <button class="m-save sw-use">Χρήση</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const pick = modal.querySelector('.sw-pick');
    function done(v) { backdrop.remove(); resolve(v); }
    modal.querySelectorAll('.sw').forEach((b) =>
      b.addEventListener('click', () => done(b.dataset.c)));
    modal.querySelector('.sw-use').addEventListener('click', () => done(pick.value));
    modal.querySelector('.m-reset').addEventListener('click', () => done(null));
    modal.querySelector('.m-cancel').addEventListener('click', () => done(undefined));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(undefined); });
  });
}

// Plain-text notes editor. Returns the text on save, or undefined if cancelled.
function notesModal(name, current) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-notes';
    modal.innerHTML = `<h3>📝 Σημειώσεις — ${escapeHtml(name)}</h3>
      <textarea class="notes-input" spellcheck="false" placeholder="Γράψε σημειώσεις, περιγραφή, TODO…"></textarea>
      <div class="m-hint">Οι 2-3 πρώτες γραμμές εμφανίζονται στο hover. Ctrl+Enter για αποθήκευση.</div>
      <div class="m-actions"><button class="m-cancel">Άκυρο</button><button class="m-save">Αποθήκευση</button></div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const ta = modal.querySelector('.notes-input');
    ta.value = current || '';
    ta.focus();
    function done(v) { backdrop.remove(); resolve(v); }
    modal.querySelector('.m-cancel').addEventListener('click', () => done(undefined));
    modal.querySelector('.m-save').addEventListener('click', () => done(ta.value));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(undefined); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(ta.value); }
      if (e.key === 'Escape') done(undefined);
    });
  });
}

// Index popup: lists every item that has notes; click to open its note.
function openNotesIndex() {
  const entries = Object.entries(notesData).filter(([, t]) => t && t.trim());
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal modal-notes';
  function close() { backdrop.remove(); }
  if (!entries.length) {
    modal.innerHTML = `<h3>📝 Σημειώσεις</h3>
      <div class="m-hint">Δεν υπάρχουν σημειώσεις ακόμη. Δεξί κλικ σε αρχείο/φάκελο → «Σημειώσεις».</div>
      <div class="m-actions"><button class="m-save">OK</button></div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modal.querySelector('.m-save').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return;
  }
  entries.sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
  const rows = entries.map(([p, t]) => `
    <div class="note-row" data-path="${escapeHtml(p)}">
      <div class="note-row-name">${escapeHtml(basename(p))}</div>
      <div class="note-row-prev">${escapeHtml(notePreview(t, 2))}</div>
    </div>`).join('');
  modal.innerHTML = `<h3>📝 Σημειώσεις (${entries.length})</h3>
    <div class="notes-list">${rows}</div>
    <div class="m-actions"><button class="m-save">Κλείσιμο</button></div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector('.m-save').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  modal.querySelectorAll('.note-row').forEach((r) => {
    r.addEventListener('click', async () => {
      const p = r.dataset.path;
      close();
      await revealAndEditNote(p);
    });
  });
}

// Reveal an item in the tree (expand ancestors), then open its note editor.
async function revealAndEditNote(p) {
  if (rootPath) {
    const sep = rootPath.includes('\\') ? '\\' : '/';
    if (p.startsWith(rootPath + sep)) {
      const rel = p.slice(rootPath.length + 1).split(sep);
      let acc = rootPath;
      for (let i = 0; i < rel.length - 1; i++) { acc = acc + sep + rel[i]; expandedDirs.add(acc); }
      await renderTree();
      const row = treeEl.querySelector(`.tree-row[data-path="${cssEscape(p)}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }
  await notesFlow({ name: basename(p), path: p });
}
function cssEscape(s) { return s.replace(/["\\]/g, '\\$&'); }

function alertModal(title, msg) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal modal-sm';
  modal.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="m-hint">${escapeHtml(msg || '')}</div>
    <div class="m-actions"><button class="m-save">OK</button></div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector('.m-save').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
}

// ---------------- source control (git) ----------------

const GIT_SYM = {
  M: { letter: 'M', cls: 'modified', title: 'Modified' },
  A: { letter: 'A', cls: 'added', title: 'Added' },
  D: { letter: 'D', cls: 'deleted', title: 'Deleted' },
  R: { letter: 'R', cls: 'renamed', title: 'Renamed' },
  C: { letter: 'C', cls: 'conflict', title: 'Conflict' },
  U: { letter: 'C', cls: 'conflict', title: 'Conflict' },
};
function gitSymbol(f) {
  if (f.index === '?' && f.working_dir === '?') return { letter: 'U', cls: 'untracked', title: 'Untracked' };
  const c = (f.working_dir && f.working_dir !== ' ' && f.working_dir !== '?') ? f.working_dir : f.index;
  return GIT_SYM[c] || { letter: c || '•', cls: 'modified', title: 'Changed' };
}

function setScmBadge(n) {
  const b = document.getElementById('scmBadge');
  b.textContent = n > 0 ? String(n) : '';
  b.style.display = n > 0 ? 'flex' : 'none';
}

async function updateScmBadge() {
  if (!rootPath) { setScmBadge(0); return; }
  const res = await window.termi.gitStatus(rootPath);
  if (res.ok && res.value.isRepo) setScmBadge((res.value.files || []).length);
  else setScmBadge(0);
}

async function refreshScm() {
  const branchEl = document.getElementById('scm-branch');
  const changesEl = document.getElementById('scm-changes');
  const countEl = document.getElementById('scm-count');

  if (!rootPath) {
    branchEl.textContent = '';
    changesEl.innerHTML = '<div class="tree-empty">Άνοιξε έναν φάκελο.</div>';
    countEl.textContent = '0'; setScmBadge(0);
    return;
  }
  const res = await window.termi.gitStatus(rootPath);
  if (!res.ok) {
    branchEl.textContent = '';
    changesEl.innerHTML = '<div class="tree-empty">Σφάλμα git</div>';
    return;
  }
  const st = res.value;
  if (!st.isRepo) {
    branchEl.textContent = '';
    countEl.textContent = '0'; setScmBadge(0);
    changesEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'tree-empty';
    msg.textContent = 'Δεν είναι git repository.';
    const initBtn = document.createElement('button');
    initBtn.className = 'scm-init';
    initBtn.textContent = 'Αρχικοποίηση repository';
    initBtn.addEventListener('click', async () => {
      const r = await window.termi.gitInit(rootPath);
      if (!r.ok) { alertModal('Σφάλμα', r.error); return; }
      refreshScm();
    });
    changesEl.append(msg, initBtn);
    return;
  }

  branchEl.innerHTML = '<i class="codicon codicon-git-branch"></i> ' + escapeHtml(st.branch || '(no branch)')
    + (st.ahead ? ` <span class="scm-track">↑${st.ahead}</span>` : '')
    + (st.behind ? ` <span class="scm-track">↓${st.behind}</span>` : '');

  const files = st.files || [];
  countEl.textContent = String(files.length);
  setScmBadge(files.length);
  changesEl.innerHTML = '';
  if (!files.length) { changesEl.innerHTML = '<div class="tree-empty">Καμία αλλαγή</div>'; return; }

  for (const f of files) {
    const sym = gitSymbol(f);
    const row = document.createElement('div');
    row.className = 'scm-row';
    row.title = f.path;

    const ic = document.createElement('i');
    ic.className = 'codicon ' + (fileIconClass(f.path)) + ' scm-ficon';

    const name = document.createElement('span');
    name.className = 'scm-name';
    name.textContent = basename(f.path);

    const dir = document.createElement('span');
    dir.className = 'scm-dir';
    dir.textContent = f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '';

    const badge = document.createElement('span');
    badge.className = 'scm-status scm-' + sym.cls;
    badge.textContent = sym.letter;
    badge.title = sym.title;

    row.append(ic, name, dir, badge);
    const full = (st.root || rootPath) + '/' + f.path;
    if (sym.letter !== 'D') row.addEventListener('click', () => openFile(full));
    changesEl.appendChild(row);
  }
}

async function doCommit() {
  if (!rootPath) return;
  const msgEl = document.getElementById('scm-message');
  const msg = msgEl.value.trim();
  if (!msg) { msgEl.focus(); return; }
  const res = await window.termi.gitCommit(rootPath, msg);
  if (!res.ok) { alertModal('Σφάλμα commit', res.error); return; }
  msgEl.value = '';
  refreshScm();
}

async function gitPushPull(which) {
  if (!rootPath) return;
  const res = which === 'push' ? await window.termi.gitPush(rootPath) : await window.termi.gitPull(rootPath);
  if (!res.ok) { alertModal('Σφάλμα ' + which, res.error); return; }
  refreshScm();
}

// ---------------- bootstrap ----------------

document.getElementById('toggleSidebar').addEventListener('click', () => toggleSidebarView('explorer'));
document.getElementById('scmBtn').addEventListener('click', () => toggleSidebarView('scm'));

// window controls (frameless)
document.getElementById('win-full').addEventListener('click', () => window.termi.winFullscreen());
document.getElementById('win-min').addEventListener('click', () => window.termi.winMinimize());
document.getElementById('win-max').addEventListener('click', () => window.termi.winMaximize());
document.getElementById('win-close').addEventListener('click', () => window.termi.winClose());
window.termi.onMaximizeChange((max) => {
  const i = document.querySelector('#win-max .codicon');
  if (i) i.className = 'codicon ' + (max ? 'codicon-chrome-restore' : 'codicon-chrome-maximize');
});

// --- auto-hide the header in fullscreen (the ⛶ / F11 button), peek on hover ---
// A dedicated top hot-zone reveals it: the header itself is a -webkit-app-region drag
// area, and drag regions swallow mouse events, so hovering the bar can't be detected
// reliably. The hot-zone is a normal (no-drag) element above the webviews; mouseenter
// fires instantly. We hide again based on the cursor's Y (not the bar's own events).
let headerHideActive = false;
const headerHotzone = document.createElement('div');
headerHotzone.id = 'header-hotzone';
document.body.appendChild(headerHotzone);

headerHotzone.addEventListener('mouseenter', () => {
  if (headerHideActive) document.body.classList.add('header-peek');
});
document.addEventListener('mousemove', (e) => {
  if (headerHideActive && e.clientY > 40) document.body.classList.remove('header-peek');
});

window.termi.onFullscreenChange((fs) => {
  const i = document.querySelector('#win-full .codicon');
  if (i) i.className = 'codicon ' + (fs ? 'codicon-screen-normal' : 'codicon-screen-full');
  document.getElementById('win-full').title = fs ? 'Έξοδος πλήρους οθόνης (F11)' : 'Πλήρης οθόνη (F11)';
  headerHideActive = fs;
  document.body.classList.toggle('header-hidden', fs);
  if (!fs) document.body.classList.remove('header-peek');
});

// Auto-hide a browser pane's bar: a per-pane hot-zone (positioned over the pane's top edge
// by layoutWebviews, above the webview) reveals it; the global mousemove collapses it again
// when the cursor leaves that top band — but not while the user is typing in the bar.
document.addEventListener('mousemove', (e) => {
  if (!peekPaneId) return;
  if (document.body.classList.contains('dragging')) return; // keep the bar up while dragging the pane
  const p = paneEl(peekPaneId);
  if (!p) { clearBarPeek(); return; }
  const bar = p.querySelector('.pane-bar');
  if (bar && bar.contains(document.activeElement)) return; // keep the bar up while typing in it
  const r = p.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY > r.top + 44) clearBarPeek();
});

// The cursor leaving the window can't produce a mousemove, so the move-based hides above
// would leave a header stuck open. Collapse on the way out (and likewise when re-entering).
document.documentElement.addEventListener('mouseleave', collapsePeeks);

// version badge in the header (guarded: the phone bridge stubs appVersion -> 'web')
const verEl = document.getElementById('app-version');
if (verEl && window.termi.appVersion) {
  window.termi.appVersion().then((v) => { verEl.textContent = v ? 'v' + v : ''; }).catch(() => {});
}

// in-app update button (left of fullscreen) — shown only when GitHub has a newer release.
// Guarded: the phone (remote web app) runs this same renderer.js over the termi-bridge
// shim, which has no updater API — so skip the wiring there instead of throwing.
const updBtn = document.getElementById('win-update');
if (updBtn && window.termi.onUpdateAvailable) {
  let updating = false;
  window.termi.onUpdateAvailable((rel) => {
    if (!rel || !rel.newer) return;
    updBtn.classList.remove('hidden');
    updBtn.dataset.version = rel.version;
    updBtn.title = `Νέα έκδοση ${rel.version} διαθέσιμη — κλικ για ενημέρωση`;
  });
  updBtn.addEventListener('click', async () => {
    if (updating) return;
    const ver = updBtn.dataset.version || '';
    if (!confirm(`Να γίνει λήψη και εγκατάσταση της έκδοσης ${ver};\nΗ εφαρμογή θα κλείσει για να ολοκληρωθεί η ενημέρωση.`)) return;
    updating = true;
    updBtn.classList.add('updating');
    const off = window.termi.onUpdateProgress((frac) => {
      updBtn.title = 'Λήψη ενημέρωσης… ' + Math.round(frac * 100) + '%';
    });
    const r = await window.termi.updateInstall();
    if (off) off();
    if (!r || !r.ok) { // on success the app quits, so we only land here on failure
      updating = false;
      updBtn.classList.remove('updating');
      updBtn.title = 'Αποτυχία ενημέρωσης — δοκίμασε ξανά';
      alert('Αποτυχία ενημέρωσης: ' + ((r && r.error) || 'άγνωστο σφάλμα'));
    }
  });
}
document.getElementById('pickRoot').addEventListener('click', pickRoot);
document.getElementById('newFile').addEventListener('click', newFileFlow);
document.getElementById('newFolder').addEventListener('click', newFolderFlow);
document.getElementById('notesIndex').addEventListener('click', openNotesIndex);

// source control wiring
document.getElementById('scmRefresh').addEventListener('click', refreshScm);
document.getElementById('scm-commit').addEventListener('click', doCommit);
document.getElementById('scm-pull').addEventListener('click', () => gitPushPull('pull'));
document.getElementById('scm-push').addEventListener('click', () => gitPushPull('push'));
document.getElementById('scm-message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); }
});
if (rootPath) updateScmBadge();

// drop on empty tree area -> move to root
treeEl.addEventListener('dragover', (e) => {
  if (!rootPath || !draggedPaths.length || !draggedPaths.some((p) => canDrop(p, rootPath))) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
treeEl.addEventListener('drop', (e) => {
  if (!rootPath || !draggedPaths.length) return;
  e.preventDefault();
  moveItems(draggedPaths, rootPath);
});
if (rootPath) { sidebarEl.classList.remove('hidden'); renderTree(); window.termi.watchDir(rootPath); }

// Auto-refresh the tree when files change on disk (e.g. a benchmark writing output).
let treeRefreshTimer = null, treeRefreshing = false, treeRefreshPending = false;
async function autoRefreshTree() {
  if (!rootPath) return;
  if (treeRefreshing) { treeRefreshPending = true; return; }
  treeRefreshing = true;
  try { await renderTree(); } finally { treeRefreshing = false; }
  if (treeRefreshPending) { treeRefreshPending = false; autoRefreshTree(); }
}
window.termi.onFsChange(() => {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => { autoRefreshTree(); refreshOpenEditors(); }, 200);
  if (rootPath && activeSidebarView === 'scm') updateScmBadge();
});

// --- sidebar width resize ---
const sidebarResizer = document.getElementById('sidebar-resizer');
const savedSidebarW = parseInt(localStorage.getItem('termi.sidebarWidth') || '', 10);
if (savedSidebarW >= 150 && savedSidebarW <= 640) sidebarEl.style.width = savedSidebarW + 'px';
sidebarResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sidebarResizer.setPointerCapture(e.pointerId);
  sidebarResizer.classList.add('dragging');
  const startX = e.clientX;
  const startW = sidebarEl.getBoundingClientRect().width;
  function move(ev) {
    const w = Math.max(150, Math.min(640, startW + (ev.clientX - startX)));
    sidebarEl.style.width = w + 'px';
  }
  function up() {
    sidebarResizer.classList.remove('dragging');
    localStorage.setItem('termi.sidebarWidth', String(parseInt(sidebarEl.style.width, 10) || 260));
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    visibleLeafIds().forEach(scheduleFit);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

document.getElementById('minimized-tray').addEventListener('click', (e) => {
  const tray = e.currentTarget;
  // toggle: a second click on the open tray closes the dropdown (cleanly) instead of reopening
  if (tray.classList.contains('open')) { if (minMenuClose) minMenuClose(); }
  else openMinimizedMenu(tray);
});
document.getElementById('addPane').addEventListener('click', addPane);
document.getElementById('addBrowser').addEventListener('click', (e) => openBrowserMenu(e.currentTarget));
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); window.termi.winFullscreen(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); addPane(); return; }
  // Delete key removes the tree selection (unless typing in an editor/terminal/input)
  if ((e.key === 'Delete' || e.key === 'Del') && selectedPaths.size) {
    const ae = document.activeElement;
    if (ae && (ae.closest('.pane') || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    e.preventDefault();
    deleteSelected();
  }
});
window.addEventListener('resize', () => visibleLeafIds().forEach(scheduleFit));

render();
