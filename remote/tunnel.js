// Cloudflare "quick tunnel" manager.
//
// A quick tunnel needs no Cloudflare account: we run the `cloudflared` binary with
// `tunnel --url http://localhost:PORT` and it prints a public
// https://<random>.trycloudflare.com URL that forwards to our local server.
//
// The binary is ~70 MB so we DON'T bundle it in the installer. On first use we
// download it once into the app's userData dir and cache it there forever.

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const https = require('https');
const { spawn } = require('child_process');

const DOWNLOAD_URL = {
  win32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  darwin: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  linux: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};

function binName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

// Download a URL to a file, following redirects (GitHub release assets redirect).
function downloadTo(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Πάρα πολλά redirects στο download'));
    const req = https.get(url, { headers: { 'User-Agent': 'termi' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadTo(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Download απέτυχε: HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got / total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(async () => {
        try { await fsp.rename(tmp, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Ensure the cloudflared binary exists; returns its absolute path.
async function ensureBinary(userDataDir, onProgress) {
  const dir = path.join(userDataDir, 'cloudflared');
  await fsp.mkdir(dir, { recursive: true });
  const bin = path.join(dir, binName());
  try { await fsp.access(bin, fs.constants.X_OK || fs.constants.F_OK); return bin; }
  catch { /* not there yet */ }

  const url = DOWNLOAD_URL[process.platform];
  if (!url) throw new Error('Το cloudflared δεν υποστηρίζεται σε αυτό το OS: ' + process.platform);
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error('Αυτόματη λήψη cloudflared υποστηρίζεται προς το παρόν σε Windows/Linux');
  }
  await downloadTo(url, bin, onProgress);
  if (process.platform !== 'win32') { try { await fsp.chmod(bin, 0o755); } catch { /* */ } }
  return bin;
}

// Start a quick tunnel to localhost:port. Resolves with { url, stop() }.
function start(bin, port, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [
      'tunnel', '--no-autoupdate',
      '--url', 'http://localhost:' + port,
    ], { windowsHide: true });

    let settled = false;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch { /* */ }
        reject(new Error('Timeout: το cloudflared δεν έδωσε δημόσιο URL'));
      }
    }, 30000);

    function scan(buf) {
      const text = buf.toString();
      if (onLog) onLog(text);
      const m = text.match(urlRe);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: m[0],
          stop() { try { proc.kill(); } catch { /* */ } },
        });
      }
    }
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan); // cloudflared prints the URL on stderr
    proc.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Το cloudflared τερμάτισε (code ' + code + ')')); }
    });
  });
}

module.exports = { ensureBinary, start };
