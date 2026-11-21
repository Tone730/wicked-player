'use strict';
/* Runs as UID 999 (ytdlp) so audio requests use the same split-tunnel egress
   that resolved the signed googlevideo URL. Emits one JSON header line, then
   pipes the upstream body to stdout. */
const https = require('https');
const dns = require('dns');
const net = require('net');
const axios = require('axios');

function blockedIP(ip) {
  if (net.isIP(ip) === 4) {
    const a = ip.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 198 && (a[1] === 18 || a[1] === 19));
  }
  const s = String(ip).toLowerCase();
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
    s.startsWith('fe80') || /^::ffff:(0|10|127|192\.168|169\.254)\./.test(s);
}

const safeLookup = (host, opts, cb) => dns.lookup(host, opts, (err, address, family) => {
  if (err) return cb(err);
  if (blockedIP(address)) return cb(new Error('blocked address'));
  cb(null, address, family);
});

const agent = new https.Agent({ lookup: safeLookup, family: 4, keepAlive: false });

const [target, range] = process.argv.slice(2);
if (!target) { console.error('missing target'); process.exit(2); }

let url;
try { url = new URL(target); } catch { console.error('invalid target'); process.exit(2); }
if (url.protocol !== 'https:' || url.username || url.password) {
  console.error('invalid audio URL'); process.exit(2);
}
if (net.isIP(url.hostname) && blockedIP(url.hostname)) {
  console.error('blocked audio host'); process.exit(2);
}

(async () => {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (range) headers.Range = range;
  const upstream = await axios.get(url.toString(), {
    headers,
    responseType: 'stream',
    timeout: 30000,
    httpsAgent: agent,
    maxRedirects: 2,
  });
  const meta = {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers['content-type'],
      'content-length': upstream.headers['content-length'],
      'content-range': upstream.headers['content-range'],
    },
  };
  process.stdout.write(JSON.stringify(meta) + '\n');
  upstream.data.on('error', (err) => {
    console.error(err && err.message || String(err));
    process.stdout.end();
  });
  upstream.data.pipe(process.stdout);
})().catch((err) => {
  console.error(err && err.message || String(err));
  process.exitCode = 1;
});
