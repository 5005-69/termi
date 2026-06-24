// termi-bridge.js — runs in the phone's browser BEFORE renderer.js.
//
// Re-implements window.termi (normally provided by Electron's preload) on top of a
// WebSocket to remote/server.js, so the UNCHANGED renderer.js runs verbatim in the
// browser while all pty/fs/git work happens on the computer. Calls made before the
// socket is authenticated are queued and flushed on connect.
(function () {
  'use strict';

  const token = (location.hash.match(/t=([^&]+)/) || [])[1] || '';

  let ws = null, authed = false, control = true;
  const outQueue = [];                 // JSON strings queued until authed
  let ridSeq = 1;
  const pending = new Map();            // rid -> {resolve}
  const dataCbs = [], exitCbs = [], fsCbs = [], maxCbs = [], fullCbs = [];

  function rawSend(obj) {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1 && authed) ws.send(s);
    else outQueue.push(s);
  }
  function fire(op, args) { rawSend({ op, args }); }
  function invoke(op, args) {
    return new Promise((resolve) => { const rid = ridSeq++; pending.set(rid, resolve); rawSend({ rid, op, args }); });
  }
  function flush() { while (outQueue.length && ws && ws.readyState === 1) ws.send(outQueue.shift()); }

  // ---------------- window.termi shim ----------------
  window.termi = {
    version: 'web-0.2.0',
    // pty
    spawn: (id, cwd, cols, rows) => fire('spawn', { id, cwd, cols, rows }),
    write: (id, data) => fire('write', { id, data }),
    resize: (id, cols, rows) => fire('resize', { id, cols, rows }),
    kill: (id) => fire('kill', { id }),
    onData: (cb) => { dataCbs.push(cb); return () => { const i = dataCbs.indexOf(cb); if (i >= 0) dataCbs.splice(i, 1); }; },
    onExit: (cb) => { exitCbs.push(cb); return () => { const i = exitCbs.indexOf(cb); if (i >= 0) exitCbs.splice(i, 1); }; },
    // filesystem
    listDir: (dir) => invoke('listDir', { dir }),
    readFile: (file) => invoke('readFile', { file }),
    writeFile: (file, data) => invoke('writeFile', { file, data }),
    mkdir: (parent, name) => invoke('mkdir', { parent, name }),
    createFile: (parent, name) => invoke('createFile', { parent, name }),
    renamePath: (target, newName) => invoke('renamePath', { target, newName }),
    deletePath: (target) => invoke('deletePath', { target }),
    movePath: (src, destDir) => invoke('movePath', { src, destDir }),
    watchDir: (dir) => fire('watchDir', { dir }),
    onFsChange: (cb) => { fsCbs.push(cb); return () => { const i = fsCbs.indexOf(cb); if (i >= 0) fsCbs.splice(i, 1); }; },
    // git
    gitStatus: (dir) => invoke('gitStatus', { dir }),
    gitCommit: (dir, message) => invoke('gitCommit', { dir, message }),
    gitPush: (dir) => invoke('gitPush', { dir }),
    gitPull: (dir) => invoke('gitPull', { dir }),
    gitInit: (dir) => invoke('gitInit', { dir }),
    // clipboard
    clipboardRead: () => invoke('clipboardRead', {}),
    clipboardWrite: (text) => fire('clipboardWrite', { text }),
    // dialogs -> custom in-browser folder picker (no native dialog on a phone)
    pickFolder: (current) => openFolderPicker(current),
    // window controls -> browser equivalents / no-ops
    winMinimize: () => {},
    winMaximize: () => {},
    winClose: () => {},
    winFullscreen: () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch (e) { /* */ } },
    onMaximizeChange: (cb) => { maxCbs.push(cb); },
    onFullscreenChange: (cb) => { fullCbs.push(cb); },
    // in-app updater — desktop-only; on the phone these are inert no-ops so the
    // shared renderer.js can call them without throwing (no update button shown).
    updateCheck: () => Promise.resolve({ ok: false, error: 'not supported on web' }),
    updateInstall: () => Promise.resolve({ ok: false, error: 'not supported on web' }),
    onUpdateAvailable: () => () => {},
    onUpdateProgress: () => () => {},
  };

  // ---------------- enable xterm smooth (sub-line) scrolling ----------------
  // A terminal renders whole character rows, so by default it scrolls one full line at a
  // time (feels chunky on touch). xterm supports `smoothScrollDuration`, which animates
  // the scroll sub-line. The renderer creates terminals via the global `Terminal`, and we
  // run before it — so we wrap the constructor to inject the option. No core change.
  (function enableSmoothScroll() {
    const Real = window.Terminal;
    if (typeof Real !== 'function' || Real.__tbWrapped) return;
    function Patched(opts) {
      const inst = new Real(Object.assign({ smoothScrollDuration: 180 }, opts || {}));
      try { inst.options.smoothScrollDuration = 180; } catch (e) { /* */ }
      return inst;
    }
    Patched.prototype = Real.prototype;
    Patched.__tbWrapped = true;
    try { Object.setPrototypeOf(Patched, Real); } catch (e) { /* */ }
    window.Terminal = Patched;
  })();

  // ---------------- websocket events ----------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = () => { authed = true; flush(); hideLogin(); };
    ws.onclose = () => { authed = false; showLogin('Η σύνδεση έκλεισε. Σκάναρε ξανά ή βάλε PIN.'); };
    ws.onmessage = (ev) => {
      let m = {}; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.rid != null && pending.has(m.rid)) { const r = pending.get(m.rid); pending.delete(m.rid); r(m.error != null ? { ok: false, error: m.error } : m.value); return; }
      if (m.event === 'ready') { control = m.control !== false; return; }
      if (m.event === 'pty:data') { dataCbs.forEach((cb) => cb({ id: m.id, data: m.data })); return; }
      if (m.event === 'pty:exit') { exitCbs.forEach((cb) => cb({ id: m.id, exitCode: m.exitCode })); return; }
      if (m.event === 'fs:changed') { fsCbs.forEach((cb) => cb()); return; }
    };
  }

  // ---------------- login overlay ----------------
  let loginEl = null;
  function buildLogin() {
    const el = document.createElement('div');
    el.id = 'tb-login';
    el.innerHTML = `
      <div class="tb-card">
        <div class="tb-logo">&gt;_ <b>termi</b></div>
        <p>Πληκτρολόγησε το PIN που εμφανίζεται στον υπολογιστή.</p>
        <input id="tb-pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="PIN" />
        <button id="tb-go">Σύνδεση</button>
        <div id="tb-err"></div>
      </div>`;
    document.body.appendChild(el);
    const pin = el.querySelector('#tb-pin');
    const go = el.querySelector('#tb-go');
    const err = el.querySelector('#tb-err');
    async function submit() {
      err.textContent = '';
      if (!token) { err.textContent = 'Λείπει το token — σκάναρε ξανά το QR.'; return; }
      const v = pin.value.trim();
      if (!v) { err.textContent = 'Γράψε το PIN.'; return; }
      try {
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, pin: v }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) { connect(); }
        else if (res.status === 429) err.textContent = 'Πολλές αποτυχημένες προσπάθειες. Κλείσε & άνοιξε ξανά την πόρτα.';
        else err.textContent = 'Λάθος PIN' + (data.left != null ? ' (απομένουν ' + data.left + ')' : '');
      } catch { err.textContent = 'Σφάλμα σύνδεσης.'; }
    }
    go.addEventListener('click', submit);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return el;
  }
  function showLogin(msg) {
    if (!loginEl) loginEl = buildLogin();
    loginEl.style.display = 'flex';
    if (msg) { const e = loginEl.querySelector('#tb-err'); if (e) e.textContent = msg; }
    const pin = loginEl.querySelector('#tb-pin'); if (pin) { pin.value = ''; setTimeout(() => pin.focus(), 50); }
  }
  function hideLogin() { if (loginEl) loginEl.style.display = 'none'; }

  // ---------------- folder picker ----------------
  async function openFolderPicker(current) {
    let dir = current || (await invoke('home', {}));
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.id = 'tb-picker';
      el.innerHTML = `
        <div class="tb-card">
          <div class="tb-row"><b>Επιλογή φακέλου</b></div>
          <div id="tb-path" class="tb-path"></div>
          <div id="tb-list" class="tb-list"></div>
          <div class="tb-actions">
            <button id="tb-cancel" class="tb-secondary">Άκυρο</button>
            <button id="tb-choose">Επιλογή αυτού</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      const pathEl = el.querySelector('#tb-path');
      const listEl = el.querySelector('#tb-list');
      function done(val) { el.remove(); resolve(val); }
      async function load(d) {
        dir = d; pathEl.textContent = d;
        const items = await invoke('listDir', { dir: d });
        listEl.innerHTML = '';
        const up = document.createElement('div'); up.className = 'tb-item'; up.textContent = '.. (πίσω)';
        up.addEventListener('click', () => { const parent = d.replace(/[\\/][^\\/]+[\\/]?$/, '') || d; load(parent || d); });
        listEl.appendChild(up);
        (items || []).filter((i) => i.isDir).forEach((i) => {
          const it = document.createElement('div'); it.className = 'tb-item'; it.textContent = '📁 ' + i.name;
          it.addEventListener('click', () => load(i.path));
          listEl.appendChild(it);
        });
      }
      el.querySelector('#tb-cancel').addEventListener('click', () => done(null));
      el.querySelector('#tb-choose').addEventListener('click', () => done(dir));
      load(dir);
    });
  }

  // shared across the mobile gesture helpers: true while a pane is being moved, so the
  // terminal touch-scroll handler stands down and lets the drag happen.
  let paneDragActive = false;

  // ---------------- mobile: scroll the terminal on touch ----------------
  // xterm v6 scrolls via a vscode ScrollableElement (`.xterm-scrollable-element`), NOT a
  // native overflow element — so setting scrollTop does nothing. It DOES react to wheel
  // events, so we translate a vertical finger-drag into synthetic wheel events. Also,
  // .xterm-screen overlays everything, so a plain touch would otherwise scroll the page.
  (function terminalTouchScroll() {
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
    let id = null, lastY = 0, el = null, acc = 0, raf = null;
    const flush = () => {
      raf = null;
      if (acc !== 0 && el) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: acc, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true })); acc = 0; }
    };
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { id = null; el = null; return; }
      const xt = e.target.closest && e.target.closest('.xterm');
      el = xt ? (xt.querySelector('.xterm-scrollable-element') || xt.querySelector('.xterm-viewport')) : null;
      if (!el) { id = null; return; }
      id = e.touches[0].identifier; lastY = e.touches[0].clientY; acc = 0;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (id === null || !el) return;
      const t = Array.prototype.find.call(e.touches, (x) => x.identifier === id);
      if (!t) return;
      e.preventDefault();                 // a terminal touch must never scroll the page
      if (paneDragActive) return;          // a pane move is happening -> don't scroll content
      acc += (lastY - t.clientY); lastY = t.clientY;   // accumulate; dispatch once per frame for smoothness
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: false });
    const end = () => { id = null; el = null; if (raf) { cancelAnimationFrame(raf); raf = null; } acc = 0; };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  })();

  // ---------------- mobile: open the keyboard only on a deliberate terminal TAP ----------------
  // The renderer focuses the terminal on every pointerdown, popping the keyboard even when
  // you only meant to scroll. We suppress that auto-focus on terminals and instead focus
  // the terminal's input (which raises the keyboard) only on a clean, stationary tap.
  (function terminalKeyboardOnTapOnly() {
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
    // (1) stop a terminal pointerdown from bubbling to the renderer's focus handler.
    //     Attached on .xterm (bubble), so xterm's own inner handlers still run first.
    const tag = (xt) => { if (xt.__tbXt) return; xt.__tbXt = true; xt.addEventListener('pointerdown', (e) => { e.stopPropagation(); }); };
    const scan = (r) => { if (r.querySelectorAll) r.querySelectorAll('.xterm').forEach(tag); };
    const obs = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.classList && n.classList.contains('xterm')) tag(n);
      scan(n);
    })));
    const start = () => { scan(document.body); obs.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

    // (2) focus (raise keyboard) only on a clean tap — not a scroll or a move.
    let dx = 0, dy = 0, dt = 0, xtEl = null, moved = false, pid = null;
    document.addEventListener('pointerdown', (e) => {
      const xt = e.target.closest && e.target.closest('.xterm');
      if (!xt) { xtEl = null; return; }
      xtEl = xt; dx = e.clientX; dy = e.clientY; dt = Date.now(); moved = false; pid = e.pointerId;
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (xtEl && e.pointerId === pid && Math.hypot(e.clientX - dx, e.clientY - dy) > 10) moved = true;
    }, true);
    document.addEventListener('pointerup', (e) => {
      if (!xtEl || e.pointerId !== pid) return;
      if (!moved && !paneDragActive && (Date.now() - dt) < 400) {
        const ta = xtEl.querySelector('.xterm-helper-textarea');
        if (ta) { try { ta.focus(); } catch (er) { /* */ } }
      }
      xtEl = null;
    }, true);
  })();

  // ---------------- mobile: keyboard-free pane dragging ----------------
  // The renderer focuses the terminal on ANY pointerdown inside a pane (line:
  // `pane.addEventListener('pointerdown', () => ... focusView())`), which pops the
  // soft keyboard. When you grab the pane BAR to drag/resize, we don't want that.
  // We stop the bar's pointerdown from bubbling to the pane's focus handler — the
  // bar's own drag handler (registered earlier, same element) still runs, and tapping
  // the terminal BODY still focuses + shows the keyboard as normal.
  (function keyboardFreeBars() {
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
    const tag = (bar) => {
      if (bar.__tbTagged) return; bar.__tbTagged = true;
      bar.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    };
    const scan = (root) => { if (root.querySelectorAll) root.querySelectorAll('.pane-bar').forEach(tag); };
    const obs = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.classList && n.classList.contains('pane-bar')) tag(n);
      scan(n);
    })));
    const start = () => { scan(document.body); obs.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  })();

  // ---------------- mobile: release focus when the keyboard is dismissed ----------------
  // No "keyboard closed" DOM event exists; we infer it from the visual viewport growing
  // back. When that happens we blur the focused field so the terminal/editor is no longer
  // "armed for typing" — which frees you to drag/resize panes right after lowering it.
  (function blurOnKeyboardClose() {
    const vv = window.visualViewport;
    if (!vv) return;
    let baseH = vv.height, kbOpen = false;   // baseH = full height (no keyboard)
    vv.addEventListener('resize', () => {
      const h = vv.height;
      if (h > baseH) baseH = h;              // track the tallest = keyboard-closed height
      if (h < baseH - 120) { kbOpen = true; } // shrunk a keyboard's worth -> open
      else if (kbOpen && h >= baseH - 60) {   // grew back near full -> closed
        kbOpen = false;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) { try { ae.blur(); } catch (e) { /* */ } }
      }
    });
  })();

  // ---------------- mobile: long-press anywhere in a pane to MOVE it in the grid ----------------
  // The renderer only lets you grab the thin top bar to move a pane. On a phone that's
  // fiddly (and clashes with the resize divider when a pane sits above). So: a long-press
  // anywhere on the pane starts a move. We don't touch the renderer — we synthesize a
  // pointerdown on that pane's bar, which kicks off the renderer's own drag logic; the
  // real finger's pointermove/up then drive and drop it exactly as a bar-drag would.
  (function longPressMove() {
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
    const LONG = 450, CANCEL = 12;
    let timer = null, sx = 0, sy = 0, bar = null, pid = null, pointers = 0;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; bar = null; };

    document.addEventListener('pointerdown', (e) => {
      pointers++;
      if (pointers > 1) { clear(); return; }                 // two fingers -> not a move
      const pane = e.target.closest('.pane');
      if (!pane) return;
      if (e.target === pane) return; // a touch on the frame itself -> handled by frameDrag (instant)
      // leave bars, controls, text-editing surfaces and launcher chips to their own jobs
      if (e.target.closest('.pane-bar, button, input, textarea, a, .launcher-bar, .monaco-editor')) return;
      const b = pane.querySelector('.pane-bar');
      if (!b) return;
      sx = e.clientX; sy = e.clientY; pid = e.pointerId; bar = b;
      document.body.classList.add('tb-nosel');  // suppress iOS magnifier/selection during a potential move
      timer = setTimeout(() => {
        timer = null;
        if (!bar) return;
        paneDragActive = true;
        const ae = document.activeElement;                   // drop the keyboard for a clean drag
        if (ae && ae.blur) { try { ae.blur(); } catch (er) { /* */ } }
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (er) { /* */ }
        try {
          bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, button: 0, buttons: 1, clientX: sx, clientY: sy }));
        } catch (er) { /* PointerEvent ctor unsupported */ }
        bar = null;
      }, LONG);
    }, true);

    document.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > CANCEL) clear(); // moved early = scroll/tap, not a long-press
    }, true);
    const end = () => { pointers = Math.max(0, pointers - 1); clear(); paneDragActive = false; document.body.classList.remove('tb-nosel'); };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
  })();

  // ---------------- mobile: grab the pane FRAME (thick border) to move it, instantly ----------------
  // Complements the long-press: touching the colored border of a pane hits the .pane
  // element itself (children cover the interior), so it's unambiguous — we start the
  // renderer's drag right away. Works from every side incl. the bottom.
  (function frameDrag() {
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (!(t && t.classList && t.classList.contains('pane'))) return; // a child, not the frame
      const bar = t.querySelector('.pane-bar');
      if (!bar) return;
      e.stopPropagation();                                  // no focus/keyboard
      paneDragActive = true;
      document.body.classList.add('tb-nosel');              // no text selection during the move
      const ae = document.activeElement;
      if (ae && ae.blur) { try { ae.blur(); } catch (er) { /* */ } }
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (er) { /* */ }
      try {
        bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: e.pointerId, isPrimary: true, button: 0, buttons: 1, clientX: e.clientX, clientY: e.clientY }));
      } catch (er) { /* PointerEvent ctor unsupported */ }
    }, true);
  })();

  // show login immediately (renderer renders behind it; its calls queue)
  if (document.body) showLogin();
  else document.addEventListener('DOMContentLoaded', showLogin);
})();
