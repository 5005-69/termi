// termi remote control — desktop-side UI glue.
//
// Lives entirely outside renderer.js: it only reads window.termiTerminals() (the one
// hook renderer.js exposes) and drives the QR modal + the remote:* bridge. If this
// file were deleted the desktop app would behave exactly as before.
(function () {
  'use strict';
  const t = window.termi;
  if (!t || !t.remoteOpen) return;

  const $ = (id) => document.getElementById(id);
  const modal = $('remote-modal');
  const panes = {
    idle: $('remote-idle'),
    loading: $('remote-loading'),
    active: $('remote-active'),
    error: $('remote-error'),
  };
  function showPane(name) {
    Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  }
  function openModal() { modal.classList.remove('hidden'); }
  function closeModal() { modal.classList.add('hidden'); }

  let statusTimer = null;

  async function refreshStatus() {
    try {
      const s = await t.remoteStatus();
      if (s && s.ok && s.open) {
        renderActive(s);
      }
    } catch { /* */ }
  }

  function renderActive(s) {
    showPane('active');
    if (s.qr) $('remoteQr').src = s.qr;
    if (s.pin) $('remotePin').textContent = s.pin;
    if (s.url) $('remoteUrl').textContent = s.url;
    const n = s.clients || 0;
    $('remoteClients').textContent = n > 0
      ? (n + ' συσκευή' + (n > 1 ? 'ές' : '') + ' συνδεδεμένη')
      : 'Καμία συσκευή ακόμη';
  }

  async function start() {
    const readOnly = $('remoteReadOnly').checked;
    showPane('loading');
    $('remoteLoadingText').textContent = 'Προετοιμασία…';
    $('remoteProgress').classList.add('hidden');
    const offProgress = t.onRemoteProgress((frac) => {
      $('remoteLoadingText').textContent = 'Λήψη cloudflared… ' + Math.round(frac * 100) + '%';
      $('remoteProgress').classList.remove('hidden');
      $('remoteProgressBar').style.width = Math.round(frac * 100) + '%';
    });
    try {
      const r = await t.remoteOpen({ readOnly });
      if (r && r.ok) {
        renderActive(r);
        clearInterval(statusTimer);
        statusTimer = setInterval(refreshStatus, 3000);
      } else {
        showError((r && r.error) || 'Άγνωστο σφάλμα');
      }
    } catch (err) {
      showError(String((err && err.message) || err));
    } finally {
      if (offProgress) offProgress();
    }
  }

  function showError(msg) {
    showPane('error');
    $('remoteErrText').textContent = msg;
  }

  async function stop() {
    clearInterval(statusTimer); statusTimer = null;
    try { await t.remoteClose(); } catch { /* */ }
    showPane('idle');
  }

  // wire up
  $('remoteBtn').addEventListener('click', async () => {
    openModal();
    const s = await t.remoteStatus().catch(() => null);
    if (s && s.ok && s.open) {
      renderActive(s);
      clearInterval(statusTimer);
      statusTimer = setInterval(refreshStatus, 3000);
    } else {
      showPane('idle');
    }
  });
  $('remoteStart').addEventListener('click', start);
  $('remoteRetry').addEventListener('click', start);
  $('remoteStop').addEventListener('click', stop);
  $('remoteCloseX').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
})();
