const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termi', {
  version: '0.2.0',

  // pty lifecycle
  spawn: (id, cwd, cols, rows) => ipcRenderer.send('pty:spawn', { id, cwd, cols, rows }),
  write: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),

  onData: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('pty:data', h);
    return () => ipcRenderer.removeListener('pty:data', h);
  },
  onExit: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', h);
    return () => ipcRenderer.removeListener('pty:exit', h);
  },

  // filesystem
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  readFile: (file) => ipcRenderer.invoke('fs:read', file),
  writeFile: (file, data) => ipcRenderer.invoke('fs:write', file, data),
  mkdir: (parent, name) => ipcRenderer.invoke('fs:mkdir', parent, name),
  createFile: (parent, name) => ipcRenderer.invoke('fs:createFile', parent, name),
  renamePath: (target, newName) => ipcRenderer.invoke('fs:rename', target, newName),
  deletePath: (target) => ipcRenderer.invoke('fs:delete', target),
  movePath: (src, destDir) => ipcRenderer.invoke('fs:move', src, destDir),

  // file tree watcher (auto-refresh)
  watchDir: (dir) => ipcRenderer.send('fs:watch', dir),
  onFsChange: (cb) => {
    const h = () => cb();
    ipcRenderer.on('fs:changed', h);
    return () => ipcRenderer.removeListener('fs:changed', h);
  },

  // git
  gitStatus: (dir) => ipcRenderer.invoke('git:status', dir),
  gitCommit: (dir, message) => ipcRenderer.invoke('git:commit', dir, message),
  gitPush: (dir) => ipcRenderer.invoke('git:push', dir),
  gitPull: (dir) => ipcRenderer.invoke('git:pull', dir),
  gitInit: (dir) => ipcRenderer.invoke('git:init', dir),

  // clipboard (handled in main; clipboard module isn't available in a sandboxed preload)
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  // dialogs
  pickFolder: (current) => ipcRenderer.invoke('dialog:pickFolder', current),

  // app info
  appVersion: () => ipcRenderer.invoke('app:version'),

  // remote control (phone via tunnel)
  remoteOpen: (opts) => ipcRenderer.invoke('remote:open', opts || {}),
  remoteClose: () => ipcRenderer.invoke('remote:close'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remoteGetPin: () => ipcRenderer.invoke('remote:getPin'),
  remoteSetPin: (pin) => ipcRenderer.invoke('remote:setPin', pin),
  onRemoteProgress: (cb) => {
    const h = (e, frac) => cb(frac);
    ipcRenderer.on('remote:progress', h);
    return () => ipcRenderer.removeListener('remote:progress', h);
  },

  // in-app updater (GitHub Releases)
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (cb) => {
    const h = (e, r) => cb(r);
    ipcRenderer.on('update:available', h);
    return () => ipcRenderer.removeListener('update:available', h);
  },
  onUpdateProgress: (cb) => {
    const h = (e, frac) => cb(frac);
    ipcRenderer.on('update:progress', h);
    return () => ipcRenderer.removeListener('update:progress', h);
  },

  // window controls (frameless)
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winFullscreen: () => ipcRenderer.send('win:fullscreen'),
  onMaximizeChange: (cb) => ipcRenderer.on('win:maximized', (e, v) => cb(v)),
  onFullscreenChange: (cb) => ipcRenderer.on('win:fullscreen', (e, v) => cb(v)),
});
