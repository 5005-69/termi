// store.js — shared settings store (the canonical "memory" of termi).
//
// A single JSON file on the PC holds the termi.* localStorage settings (command
// launchers, web-app chips, notes, folder colors, prefs…). BOTH the desktop app
// (main.js) AND the phone (via remote/server.js) read/write THIS file, so opening
// termi on the phone shows the SAME buttons & settings as the desktop, and an edit
// on either side persists for both.
//
// Values are stored exactly as their localStorage strings (key -> string), so a
// renderer can seed localStorage verbatim with no parsing.

const fs = require('fs');
const path = require('path');

function storePath(userDataDir) {
  return path.join(userDataDir, 'termi-store.json');
}

// Read the whole store ({} if missing/corrupt). Cheap — the file is tiny.
function read(userDataDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(storePath(userDataDir), 'utf8'));
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}

// Read-merge-write so concurrent writers (the desktop + the in-process remote
// server share one Electron process) don't clobber each other's keys. `updates`
// maps key -> string, or null to delete the key. Only termi.* keys are accepted.
function merge(userDataDir, updates) {
  const cur = read(userDataDir);
  let changed = false;
  for (const k of Object.keys(updates || {})) {
    if (typeof k !== 'string' || k.indexOf('termi.') !== 0) continue;
    const v = updates[k];
    if (v == null) { if (k in cur) { delete cur[k]; changed = true; } }
    else if (cur[k] !== String(v)) { cur[k] = String(v); changed = true; }
  }
  if (changed) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const tmp = storePath(userDataDir) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur), 'utf8');
      fs.renameSync(tmp, storePath(userDataDir));   // atomic-ish replace
    } catch { /* best-effort; an unwritable store just won't sync */ }
  }
  return cur;
}

module.exports = { read, merge, storePath };
