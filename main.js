const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const pty = require('node-pty');
const simpleGit = require('simple-git');

/** @type {Map<string, import('node-pty').IPty>} */
const ptys = new Map();

const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.COMSPEC && /powershell/i.test(process.env.COMSPEC) ? process.env.COMSPEC : 'powershell.exe')
  : (process.env.SHELL || 'bash');

let mainWindow = null;

// Remote-control module is loaded lazily (only when the "door" is opened) so it
// adds zero overhead to normal desktop use. See remote/server.js.
let remote = null;
function getRemote() {
  if (!remote) remote = require('./remote/server');
  return remote;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0d1117',
    title: 'termi',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // enable Chromium's built-in PDF viewer
    },
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false));
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('win:fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('win:fullscreen', false));

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // mainWindow.webContents.openDevTools();
}

// ---------------- pty management ----------------

function spawnPty(id, cwd, cols, rows) {
  if (ptys.has(id)) return;
  let cwdSafe = cwd;
  try {
    if (!cwdSafe || !require('fs').existsSync(cwdSafe)) cwdSafe = os.homedir();
  } catch { cwdSafe = os.homedir(); }

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwdSafe,
    env: process.env,
  });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
  });

  ptys.set(id, proc);
}

ipcMain.on('pty:spawn', (e, { id, cwd, cols, rows }) => spawnPty(id, cwd, cols, rows));

ipcMain.on('pty:input', (e, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch { /* ignore transient */ }
  }
});

ipcMain.on('pty:kill', (e, { id }) => {
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch { /* */ } ptys.delete(id); }
});

ipcMain.handle('fs:list', async (e, dir) => {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const mapped = await Promise.all(ents.map(async (d) => {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      // OneDrive/cloud placeholders & symlinks are reparse points: readdir reports
      // them as links, not dirs, so isDirectory() is false even for real folders.
      // Resolve the true type with a real stat (which follows the reparse point).
      if (!isDir && !d.isFile()) {
        try { isDir = (await fsp.stat(full)).isDirectory(); } catch { /* keep as file */ }
      }
      return { name: d.name, path: full, isDir };
    }));
    return mapped.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  } catch {
    return [];
  }
});

async function doOp(fn) {
  try { const r = await fn(); return { ok: true, value: r }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

ipcMain.handle('fs:read', (e, file) => doOp(() => fsp.readFile(file, 'utf8')));
ipcMain.handle('fs:write', (e, file, data) => doOp(() => fsp.writeFile(file, data, 'utf8')));
ipcMain.handle('fs:mkdir', (e, parent, name) => doOp(() => fsp.mkdir(path.join(parent, name))));
ipcMain.handle('fs:createFile', (e, parent, name) => doOp(() => fsp.writeFile(path.join(parent, name), '', { flag: 'wx' })));
ipcMain.handle('fs:rename', (e, target, newName) => doOp(() => fsp.rename(target, path.join(path.dirname(target), newName))));
// Custom recursive delete. Node's fs.rm({recursive:true}) HANGS on Windows when a
// directory tree is read-only and/or contains OneDrive cloud placeholders (it retries
// forever instead of throwing). We walk it ourselves: clear the read-only attribute at
// each node, then remove bottom-up with unlink/rmdir.
async function rmrf(target) {
  let st;
  try { st = await fsp.lstat(target); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try { await fsp.chmod(target, 0o666); } catch { /* best effort: clears read-only */ }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let kids = [];
    try { kids = await fsp.readdir(target); } catch { /* */ }
    for (const k of kids) await rmrf(path.join(target, k));
    await fsp.rmdir(target);
  } else {
    await fsp.unlink(target);
  }
}

ipcMain.handle('fs:delete', (e, target) => doOp(() => rmrf(target)));

// ---------------- file tree watcher (auto-refresh) ----------------

let fsWatcher = null;
let fsWatchDir = null;
let fsWatchTimer = null;

function watchRoot(dir) {
  if (dir === fsWatchDir) return;
  if (fsWatcher) { try { fsWatcher.close(); } catch { /* */ } fsWatcher = null; }
  fsWatchDir = dir || null;
  if (!dir) return;
  try {
    // recursive watch is supported on Windows & macOS
    fsWatcher = require('fs').watch(dir, { recursive: true }, () => {
      // Coalesce bursts (a benchmark can write hundreds of files at once).
      clearTimeout(fsWatchTimer);
      fsWatchTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fs:changed');
      }, 250);
    });
    fsWatcher.on('error', () => { try { fsWatcher.close(); } catch { /* */ } fsWatcher = null; });
  } catch { /* watch unsupported / dir gone */ }
}

ipcMain.on('fs:watch', (e, dir) => watchRoot(dir));
ipcMain.handle('fs:move', (e, src, destDir) => doOp(async () => {
  const target = path.join(destDir, path.basename(src));
  if (target === src) return;
  let exists = false;
  try { await fsp.access(target); exists = true; } catch { /* not there */ }
  if (exists) throw new Error('Υπάρχει ήδη στοιχείο με αυτό το όνομα στον προορισμό');
  await fsp.rename(src, target);
}));

// ---------------- git (simple-git) ----------------

ipcMain.handle('git:status', (e, dir) => doOp(async () => {
  const git = simpleGit(dir);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) return { isRepo: false };
  const top = (await git.revparse(['--show-toplevel'])).trim();
  const s = await git.status();
  return {
    isRepo: true,
    root: top,
    branch: s.current,
    ahead: s.ahead,
    behind: s.behind,
    files: s.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir })),
  };
}));

ipcMain.handle('git:commit', (e, dir, message) => doOp(async () => {
  const git = simpleGit(dir);
  await git.add(['-A']);
  return git.commit(message);
}));

ipcMain.handle('git:push', (e, dir) => doOp(() => simpleGit(dir).push()));
ipcMain.handle('git:pull', (e, dir) => doOp(() => simpleGit(dir).pull()));
ipcMain.handle('git:init', (e, dir) => doOp(() => simpleGit(dir).init()));

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (e, text) => clipboard.writeText(text || ''));

ipcMain.handle('dialog:pickFolder', async (e, current) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Επιλογή φακέλου εργασίας',
    defaultPath: current || os.homedir(),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------------- remote control (phone via Cloudflare tunnel) ----------------

ipcMain.handle('remote:open', async (e, opts) => {
  try {
    const r = getRemote();
    const result = await r.open({
      getWindow: () => mainWindow,
      userDataDir: app.getPath('userData'),
      controlEnabled: !(opts && opts.readOnly),
      onProgress: (frac) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('remote:progress', frac);
        }
      },
    });
    return { ok: true, ...result };
  } catch (err) {
    try { getRemote().close(); } catch { /* */ }
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('remote:close', () => { try { return { ok: true, ...getRemote().close() }; } catch (err) { return { ok: false, error: String(err) }; } });
ipcMain.handle('remote:status', () => { try { return { ok: true, ...getRemote().status() }; } catch (err) { return { ok: false, error: String(err) }; } });

// ---------------- app lifecycle ----------------

// window control ipc (frameless custom titlebar)
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.on('win:fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // remove File/Edit/View/Window/Help menu bar
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (remote && remote.isOpen()) { try { remote.close(); } catch { /* */ } }
  for (const p of ptys.values()) { try { p.kill(); } catch { /* */ } }
  ptys.clear();
  if (process.platform !== 'darwin') app.quit();
});
