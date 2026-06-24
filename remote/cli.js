#!/usr/bin/env node
// termi remote — standalone "door" opener.
//
// Opens the remote door WITHOUT launching the Electron app: it runs the same
// remote/server.js backend directly, then prints the QR code + PIN right in the
// terminal. Scan the QR with your phone, type the PIN, and the full termi app
// loads in the phone browser while pty/fs/git run on this computer.
//
//   node remote/cli.js            # full control
//   node remote/cli.js --read-only   # phone can browse/read but not run/edit
//
// Press Ctrl+C to close the door (stops the tunnel and kills phone sessions).

const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const server = require('./server');

// Match Electron's app.getPath('userData') so we reuse the SAME cached cloudflared
// binary the desktop app already downloaded (no re-download). appName = 'termi'.
function userDataDir() {
  const name = 'termi';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

const args = process.argv.slice(2);
const readOnly = args.includes('--read-only') || args.includes('-r');

// Resolve the door PIN WITHOUT baking a personal code into the repo:
//   1. env TERMI_PIN  2. a local, gitignored remote/.pin file  3. a fresh random PIN.
// Keep your own fixed code by writing it into remote/.pin (see remote/.pin.example).
function resolvePin() {
  if (process.env.TERMI_PIN) return process.env.TERMI_PIN.trim();
  try {
    const fromFile = fs.readFileSync(path.join(__dirname, '.pin'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* no .pin file — fall through to a random code */ }
  return null; // null => server.open() generates a fresh random PIN
}
const FIXED_PIN = resolvePin();

async function main() {
  let lastPct = -1;
  const result = await server.open({
    userDataDir: userDataDir(),
    controlEnabled: !readOnly,
    pin: FIXED_PIN,
    onProgress: (frac) => {
      const pct = Math.round(frac * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\rΛήψη cloudflared (μία φορά)… ${pct}%   `);
        if (pct >= 100) process.stdout.write('\n');
      }
    },
  });

  // QR straight in the terminal (encodes the same URL+token as the desktop modal).
  const qr = await QRCode.toString(result.fullUrl, { type: 'terminal', small: true });

  console.log('\n  📡  Η πόρτα του termi είναι ΑΝΟΙΧΤΗ' + (readOnly ? '  (read-only)' : ''));
  console.log('  ────────────────────────────────────────────\n');
  console.log(qr);
  console.log(`  PIN:  ${result.pin}`);
  console.log(`  URL:  ${result.url}`);
  console.log('\n  Σκάναρε το QR με το κινητό, γράψε το PIN, και φορτώνει όλη η εφαρμογή.');
  console.log('  Πάτα Ctrl+C εδώ για να κλείσεις την πόρτα.\n');

  // Notify when devices connect/disconnect.
  let lastClients = 0;
  setInterval(() => {
    const s = server.status();
    if (s.open && s.clients !== lastClients) {
      lastClients = s.clients;
      console.log(`  • Συνδεδεμένες συσκευές: ${s.clients}`);
    }
  }, 2000).unref();
}

function shutdown() {
  console.log('\n  Κλείνω την πόρτα…');
  try { server.close(); } catch { /* */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('\n  ❌ Σφάλμα:', (err && err.message) || err);
  try { server.close(); } catch { /* */ }
  process.exit(1);
});
