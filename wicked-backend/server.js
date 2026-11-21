require('dotenv').config();
const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { spawn } = require('child_process');

/* Block SSRF: never dial private/loopback/link-local addresses from proxies. */
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
const safeHttpsAgent = new https.Agent({ lookup: safeLookup, family: 4 });

const app = express();
const server = http.createServer(app);

/* baseline security headers, request ids, and rate limits */
const { applyHardening } = require('./lib/hardening');
const { readJSON, atomicWriteJSON, tryWriteJSON } = require('./lib/store');
const accessLog = require('./lib/access-log');
applyHardening(app);
app.use(accessLog.middleware);

const ALLOWED_ORIGINS = (process.env.SOCKET_ORIGINS ||
  'https://wickedplayer.dev,https://www.wickedplayer.dev,http://localhost:5000')
  .split(',').map((s) => s.trim()).filter(Boolean);
const corsOpts = { origin: ALLOWED_ORIGINS, credentials: true };
app.use(cors(corsOpts));
app.use(compression());
app.use(express.json({ limit: '30mb' }));

/* ============================================================
   AUTH & ADMIN — accounts, sessions, bans/timeouts, discord oauth
============================================================ */
const auth = require('./auth');
app.use(auth.router);        // /auth/* + /admin/api/* (self-guarded)
app.use(auth.gate);          // blocks protected APIs for logged-out / banned users

/* ============================================================
   COMMUNITY (profiles, friends, chat, presence, listen rooms)
============================================================ */
const community = require('./community');
const { Server } = require('socket.io');
const io = new Server(server, { cors: corsOpts, maxHttpBufferSize: 1e6 });
app.use(community.router);
community.attach(io);

/* Operational alerting: persisted to data/alerts.json, emitted to admin
   clients, and optionally POSTed to ALERT_WEBHOOK_URL. Never breaks playback. */
const alerts = require('./alerts');
alerts.attachSocket(io);
/* Live usage events are pushed only to signed-in admins. */
auth.setUsageEmitter((row) => {
  try {
    const room = io.sockets.adapter.rooms.get('admins');
    if (room && room.size) io.to('admins').emit('usage:heartbeat', row);
  } catch {}
});

/* media files (uploaded images/audio/video) */
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR, {
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

/* Upload a file as base64 data URL. The extension is derived from the
   actual bytes, never from the claimed name/MIME. */
const MAX_UPLOAD = { image: 10e6, audio: 25e6, video: 25e6 };
function sniffType(b, claimed) {
  const s = (n, o = 0) => b.slice(o, o + n).toString('latin1');
  if (s(3) === 'GIF8') return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (s(4) === 'RIFF' && s(4, 8) === 'WEBP')
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (s(4) === 'RIFF' && s(4, 8) === 'WAVE')
    return { mime: 'audio/wav', ext: 'wav', kind: 'audio' };
  if (s(3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
    return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  if (s(4) === 'ftyp') {
    return /^audio\//i.test(String(claimed || ''))
      ? { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' }
      : { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  return null;
}
app.post('/upload', (req, res) => {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(req.body?.data || ''));
  if (!m) return res.status(400).json({ error: 'missing data' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  if (buf.length > 25e6) return res.status(413).json({ error: 'file too large' });
  const type = sniffType(buf, m[1]);
  if (!type) return res.status(400).json({ error: 'unsupported file type' });
  if (buf.length > MAX_UPLOAD[type.kind]) return res.status(413).json({ error: 'file too large' });

  const file = crypto.randomBytes(16).toString('hex') + '.' + type.ext;
  fs.writeFile(path.join(MEDIA_DIR, file), buf, { flag: 'wx' }, (err) => {
    if (err) return res.status(500).json({ error: 'save failed' });
    const label = String(req.body?.name || file).replace(/[\u0000-\u001f]/g, '').slice(0, 80);
    const track = {
      id: 'file-' + file,
      name: type.kind === 'image' ? label : label.replace(/\.[^.]+$/, ''),
      artist: 'Local file', album: 'Your files', art: null, duration_ms: 0,
      stream_url: `/media/${file}`, local: true,
      kind: type.kind === 'audio' ? 'track' : 'video',
    };
    if (type.kind !== 'audio') track.video = true;
    res.json({ file, url: `/media/${file}`, track });
  });
});

/* ============================================================
   PLAYLISTS (persisted in playlists.json, atomically)
============================================================ */
const PLAYLISTS_FILE = path.join(__dirname, 'data', 'playlists.json');
const sessionUser = (req) => auth.userFromReq(req)?.username || null;

function loadPlaylists() {
  const list = readJSON(PLAYLISTS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function savePlaylists(list) {
  try { atomicWriteJSON(PLAYLISTS_FILE, list); return true; }
  catch (e) {
    process.stderr.write(`[playlists] save failed: ${e && e.message || e}\n`);
    return false;
  }
}
/* One-time migration: legacy playlists had no `user` field and were therefore
   invisible to everyone. Attach them to the admin account and keep a copy of
   the original file before rewriting. */
(function migratePlaylists() {
  try {
    const list = loadPlaylists();
    if (!list.some((pl) => !pl.user)) return;
    const backup = PLAYLISTS_FILE + '.pre-user-migration';
    if (!fs.existsSync(backup)) fs.copyFileSync(PLAYLISTS_FILE, backup);
    for (const pl of list) if (!pl.user) pl.user = 'admin';
    atomicWriteJSON(PLAYLISTS_FILE, list);
    process.stderr.write('[playlists] migrated legacy entries to admin\n');
  } catch (e) {
    process.stderr.write(`[playlists] migration skipped: ${e && e.message || e}\n`);
  }
})();

app.get('/library/playlists', (req, res) => {
  const user = sessionUser(req);
  const list = loadPlaylists();
  res.json(list.filter((pl) => pl.user === user));
});

app.post('/library/playlists', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  let list = [];
  list = loadPlaylists();
  const { name, tracks, public: isPublic } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'missing name' });
  let pl = list.find((p) => p.name === name && p.user === user);
  if (!pl) {
    pl = { name, user, tracks: [], created: Date.now() };
    list.push(pl);
  }
  if (isPublic !== undefined) pl.public = !!isPublic;
  if (Array.isArray(tracks)) {
    for (const t of tracks) if (t?.id && !pl.tracks.find((x) => x.id === t.id)) pl.tracks.push(t);
  }
  fs.mkdirSync(path.dirname(PLAYLISTS_FILE), { recursive: true });
  if (!savePlaylists(list)) return res.status(500).json({ error: 'Could not save playlist. Please try again.' });
  res.json(list.filter((p) => p.user === user));
});

app.delete('/library/playlists/:name', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  let list = [];
  list = loadPlaylists();
  list = list.filter((p) => !(p.name === req.params.name && p.user === user));
  if (!savePlaylists(list)) return res.status(500).json({ error: 'Could not save playlist. Please try again.' });
  res.json(list.filter((p) => p.user === user));
});


/* ============================================================
   PLAYLIST VISIBILITY (public/private) + discovery feed
============================================================ */
app.post('/library/playlists/visibility', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  let list = [];
  list = loadPlaylists();
  const { name, isPublic } = req.body;
  const pl = list.find((p) => p.name === name && p.user === user);
  if (!pl) return res.status(404).json({ error: 'playlist not found' });
  pl.public = !!isPublic;
  if (!savePlaylists(list)) return res.status(500).json({ error: 'Could not save playlist. Please try again.' });
  res.json({ ok: true, name: pl.name, public: !!pl.public });
});
app.get('/library/playlists/public', (req, res) => {
  try {
    const list = loadPlaylists();
    res.json(list.filter((p) => p.public && p.user).map((p) => ({
      name: p.name, user: p.user, total: (p.tracks || []).length, tracks: p.tracks || [], created: p.created,
    })).sort((a, b) => b.created - a.created).slice(0, 50));
  } catch { res.json([]); }
});

/* ============================================================
   FAVORITE ARTISTS (per user)
============================================================ */
app.post('/library/artist-like', (req, res) => {
  let lib = {};
  try { lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch {}
  const { user, artist } = req.body;
  if (!user || !artist) return res.status(400).json({ error: 'missing user/artist' });
  lib.artistLikes = lib.artistLikes || {};
  const arr = lib.artistLikes[user] = lib.artistLikes[user] || [];
  const i = arr.findIndex((a) => a.toLowerCase() === String(artist).toLowerCase());
  if (i >= 0) arr.splice(i, 1); else arr.push(String(artist).slice(0, 80));
  tryWriteJSON(LIB_FILE, lib);
  res.json({ likes: arr, liked: i < 0 });
});
app.get('/library/artists', (req, res) => {
  const user = String(req.query.user || '');
  try {
    const lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
    res.json(lib.artistLikes?.[user] || []);
  } catch { res.json([]); }
});
/* ============================================================
   YOUTUBE LINK IMPORT (paste a full song/video link)
============================================================ */
app.get('/import/youtube', async (req, res) => {
  const url = String(req.query.url || '');
  if (/youtu(\.be|be\.com)/i.test(url) === false) {
    return res.status(400).json({ error: 'Paste a YouTube video link' });
  }
  try {
    const info = await ytdlp(url, { dumpSingleJson: true, noWarnings: true, ...(fs.existsSync('/var/lib/ytdlp/cookies.txt') ? { cookies: '/var/lib/ytdlp/cookies.txt' } : {}) });
    const audioFormats = (info.formats || []).filter(
      (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const best = audioFormats[0];
    if (!best || !best.url) return res.status(404).json({ error: 'No audio stream found' });

    const name = info.title.replace(/\([^)]*\)/, '').trim();
    const track = {
      id: 'yt-' + info.id,
      name,
      artist: info.uploader || 'YouTube',
      album: 'YouTube',
      art: info.thumbnail || null,
      duration_ms: (info.duration || 0) * 1000,
      stream_url: `/audio?u=${encodeURIComponent(best.url)}` + (req.query.norange ? '&range=1' : ''),
      yt: true,
    };
    res.json(track);
  } catch (error) {
    console.error('YT Import Error:', error.message);
    res.status(500).json({ error: 'Could not resolve that YouTube link' });
  }
});

/* ============================================================
   LIBRARY STORE (liked songs + history JSON persistence)
============================================================ */
const DATA_DIR = path.join(__dirname, 'data');
const LIB_FILE = path.join(DATA_DIR, 'library.json');

function loadLib() {
  try {
    return JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
  } catch {
    return { likes: [], history: [] };
  }
}
function saveLib(lib) {
  try { atomicWriteJSON(LIB_FILE, lib); return true; }
  catch (e) {
    process.stderr.write(`[library] save failed: ${e && e.message || e}\n`);
    return false;
  }
}

app.get('/library', (req, res) => res.json(loadLib()));

app.post('/library/like', (req, res) => {
  const lib = loadLib();
  const { track } = req.body;
  if (!track?.id) return res.status(400).json({ error: 'missing track' });
  const i = lib.likes.findIndex((t) => t.id === track.id);
  if (i >= 0) lib.likes.splice(i, 1);
  else lib.likes.unshift(track);
  saveLib(lib);
  res.json({ liked: i < 0, likes: lib.likes });
});

app.post('/library/history', (req, res) => {
  const lib = loadLib();
  const { track, user } = req.body;
  if (!track?.id) return res.status(400).json({ error: 'missing track' });
  lib.history = lib.history.filter((t) => !(t.id === track.id && t.user === (user || ''))); // dedupe
  lib.history.unshift({ ...track, user: user || 'guest', playedAt: Date.now() });
  lib.history = lib.history.slice(0, 400);
  saveLib(lib);
  res.json({ ok: true });
});

/* ============================================================
   LISTENING STATS (Wrapped): minutes + top songs/artists per user
============================================================ */
const STATS_FILE = path.join(DATA_DIR, 'listen-stats.json');
function readStats() { try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return {}; } }
app.post('/api/stats/listen', (req, res) => {
  const user = String(req.body.user || 'guest').slice(0, 40);
  const secs = Math.max(0, Math.min(3600, Number(req.body.secs) || 60));
  const st = readStats();
  const u = st[user] = st[user] || { total: 0, months: {} };
  const month = new Date().toISOString().slice(0, 7);
  u.total += secs;
  u.months[month] = (u.months[month] || 0) + secs;
  tryWriteJSON(STATS_FILE, st);
  res.json({ ok: true });
});
app.get('/api/stats', (req, res) => {
  const user = String(req.query.user || 'guest').slice(0, 40);
  const st = readStats();
  const u = st[user] || { total: 0, months: {} };
  const month = new Date().toISOString().slice(0, 7);
  let lib = {};
  try { lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch {}
  const mine = (lib.history || []).filter((h) => (h.user || 'guest') === user);
  const songCounts = {}, artistCounts = {};
  for (const h of mine) {
    const k = h.name + '|' + h.artist;
    songCounts[k] = songCounts[k] || { name: h.name, artist: h.artist, art: h.art, count: 0 };
    songCounts[k].count++;
    const a = (h.artist || 'Unknown').split(',')[0];
    artistCounts[a] = (artistCounts[a] || 0) + 1;
  }
  const topSongs = Object.values(songCounts).sort((a, b) => b.count - a.count).slice(0, 10);
  const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([artist, count]) => ({ artist, count }));
  res.json({
    totalMinutes: Math.round(u.total / 60),
    monthMinutes: Math.round((u.months[month] || 0) / 60),
    plays: mine.length,
    topSongs, topArtists,
  });
});


/* ============================================================
   SEARCH: iTunes Search API (free, no auth, millions of songs)
============================================================ */
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing ?q= search term' });

  /* Start resolving the literal query in the background immediately, in parallel
     with the catalog APIs. By the time the user sees results and clicks, the
     slow YouTube lookup is usually already cached or in flight. */
  warmStream(query);

  const one = (p) => p.then((v) => v).catch(() => []);

  /* --- iTunes (previews + metadata, fast, no auth) --- */
  const itunesP = one(axios.get('https://itunes.apple.com/search', {
    params: { term: query, media: 'music', entity: 'song', limit: 25 },
    timeout: 10000,
  }).then((response) => response.data.results.map((t) => ({
    id: `it-${t.trackId}`,
    name: t.trackName,
    artist: t.artistName,
    album: t.collectionName,
    art: t.artworkUrl100 ? t.artworkUrl100.replace('100x100', '600x600') : null,
    duration_ms: t.trackTimeMillis,
    genre: t.primaryGenreName,
    preview_url: t.previewUrl,
    stream_url: `/stream?q=${encodeURIComponent(t.trackName + ' ' + t.artistName)}`,
    src: 'itunes',
  }))));

  /* --- Deezer (keyless, huge catalog, 30s previews) --- */
  const deezerP = one(axios.get('https://api.deezer.com/search', {
    params: { q: query, limit: 25 },
    timeout: 10000,
  }).then((response) => (response.data.data || []).map((t) => ({
    id: `dz-${t.id}`,
    name: t.title_short || t.title,
    artist: t.artist?.name || 'Unknown',
    album: t.album?.title || '',
    art: t.album?.cover_big || t.album?.cover_medium || null,
    duration_ms: (t.duration || 0) * 1000,
    genre: null,
    preview_url: t.preview || null,
    stream_url: `/stream?q=${encodeURIComponent((t.title_short || t.title) + ' ' + (t.artist?.name || ''))}`,
    src: 'deezer',
  }))));

  /* --- Spotify (official catalog via client-credentials, optional) --- */
  const spotifyP = one(getSpotifyToken().then(async (tok) => {
    if (!tok) return [];
    try {
      const r = await axios.get('https://api.spotify.com/v1/search', {
        params: { q: query, type: 'track', limit: 10 },
        headers: { Authorization: `Bearer ${tok}` },
        timeout: 10000,
      });
      return (r.data.tracks?.items || []).map((t) => ({
        id: `sp-${t.id}`,
        name: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        album: t.album?.name || '',
        art: t.album?.images?.[0]?.url || null,
        duration_ms: t.duration_ms || 0,
        genre: null,
        preview_url: t.preview_url || null,
        stream_url: `/stream?q=${encodeURIComponent(t.name + ' ' + (t.artists?.[0]?.name || ''))}`,
        src: 'spotify',
      }));
    } catch (e) {
      console.error(`Spotify search failed: ${e.message}`);
      return [];
    }
  }));

  /* Search in parallel: iTunes + Deefer first (fast, no auth), Spotify optional */
  const [it, dz, sp] = await Promise.all([itunesP, deezerP, spotifyP]);

  /* merge + dedupe: iTunes + Deezer first (fastest), then Spotify if available */
  const seen = new Set();
  const merged = [];
  for (const t of [...sp, ...it, ...dz]) {
    if (!t?.name || !t.stream_url) continue;
    const key = (t.name + '|' + t.artist).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  if (!merged.length) return res.status(500).json({ error: 'Search failed' });
  // relevance sort: exact title match first, then starts-with, then contains
  var qLower = query.toLowerCase();
  merged.sort(function (a, b) {
    var aN = (a.name || '').toLowerCase();
    var bN = (b.name || '').toLowerCase();
    var aS = 0, bS = 0;
    if (aN === qLower) aS -= 100;
    if (bN === qLower) bS -= 100;
    if (aN.indexOf(qLower) === 0) aS -= 50;
    if (bN.indexOf(qLower) === 0) bS -= 50;
    if (aN.indexOf(qLower) !== -1) aS -= 10;
    if (bN.indexOf(qLower) !== -1) bS -= 10;
    return aS - bS;
  });

  /* Warm the top few real result queries (the ones users are most likely to
     click) without delaying the search response. The queue is serialized so
     we never spawn several expensive yt-dlp processes at once. */
  for (const t of merged.slice(0, 3)) {
    try {
      warmStream(new URL(t.stream_url, 'http://localhost').searchParams.get('q'));
    } catch {}
  }
  res.json(merged);
});

/* is Spotify connected? (UI badge) */
app.get('/api/spotify/status', async (req, res) => {
  const tok = await getSpotifyToken();
  res.json({ connected: !!tok });
});

/* ============================================================
   SUGGEST: instant as-you-type suggestions (Deezer only = fast)
============================================================ */
app.get('/suggest', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const r = await axios.get('https://api.deezer.com/search', {
      params: { q, limit: 6 },
      timeout: 5000,
    });
    res.json((r.data.data || []).map((t) => ({
      name: t.title_short || t.title,
      artist: t.artist?.name || '',
      art: t.album?.cover_small || null,
    })));
  } catch { res.json([]); }
});

/* ============================================================
   RADIO: 50k+ live stations via radio-browser.info (keyless)
============================================================ */
app.get('/radio', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const bases = [
    'https://de1.api.radio-browser.info',
    'https://nl1.api.radio-browser.info',
    'https://at1.api.radio-browser.info',
  ];
  for (const base of bases) {
    try {
      const r = await axios.get(`${base}/json/stations/search`, {
        params: q
          ? { name: q, limit: 30, hidebroken: 'true', order: 'votes', reverse: 'true' }
          : { limit: 30, hidebroken: 'true', order: 'votes', reverse: 'true' },
        timeout: 8000,
        headers: { 'User-Agent': 'WickedPlayer/1.1' },
      });
      const stations = (r.data || [])
        .filter((s) => s.url_resolved)
        .map((s) => ({
          id: `ra-${s.stationuuid}`,
          name: s.name || 'Unknown station',
          artist: [s.country, s.tags?.split(',')[0]].filter(Boolean).join(' · ') || 'Radio',
          album: 'Live radio',
          art: s.favicon && /^https:/.test(s.favicon) ? s.favicon : null,
          duration_ms: 0,
          genre: s.tags?.split(',')[0] || null,
          preview_url: null,
          stream_url: `/audio?u=${encodeURIComponent(s.url_resolved)}`,
          src: 'radio',
        }));
      return res.json(stations);
    } catch { /* try next mirror */ }
  }
  res.status(500).json({ error: 'Radio search failed' });
});

/* --- admin key + codes helper (used by rewards) --- */
if (!process.env.ADMIN_KEY) throw new Error('ADMIN_KEY must be set in .env');
const ADMIN_KEY = process.env.ADMIN_KEY;
const adminAuth = (req, res, next) => {
  const a = Buffer.from(String(req.get('X-ADMIN-KEY') || ''));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ msg: 'no' });
  next();
};
const codesFile = './data/codes.json';
function jsonRead(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function jsonWrite(file, data) { tryWriteJSON(file, data); }
/* ============================================================
   REWARDS: random drops for listening time - claim via Discord
============================================================ */
const rewardsFile = './data/rewards.json';
async function readRewards() {
  try { return JSON.parse(await fs.promises.readFile(rewardsFile, 'utf8')); } catch { return { issued: [] }; }
}
async function writeRewards(d) { await fs.promises.writeFile(rewardsFile, JSON.stringify(d, null, 2)); }
  const REWARD_TYPES = [
    { type: 'badge',     label: 'Loyalty badge - show it off on your profile',      weight: 18 },
    { type: 'bonus',     label: 'Bonus soundboard pack (this week only)',           weight: 14 },
    { type: 'shoutout',  label: 'Discord shoutout from the host',                    weight: 10 },
    { type: 'skip',      label: '5 unlimited-skip boosters',                        weight: 12 },
    { type: 'premium',   label: 'FREE Premium code - redeem in Settings',           weight: 8  },
    { type: 'jackpot',   label: 'JACKPOT - 7-day Premium code',                     weight: 3  },
    { type: 'skip10',    label: '10 unlimited-skip boosters',                       weight: 8  },
    { type: 'avatar',    label: 'Animated avatar frame - 30 days',                  weight: 6  },
    { type: 'eqboost',   label: 'Bonus EQ preset: Bass Cannon (30 days)',           weight: 6  },
    { type: 'theme',     label: 'Custom theme unlock - 30 days',                    weight: 5  },
    { type: 'playlist',  label: 'Extra playlist slot +10 tracks',                   weight: 7  },
    { type: 'doublexp',  label: 'Double listening XP - 1 hour',                     weight: 5  },
    { type: 'mystery',   label: '??? Mystery box - could be anything',              weight: 4  },
    { type: 'mega',      label: 'MEGA DROP - 30-day Premium + badge + 20 skips',    weight: 2  },
  ];
function rollReward() {
  const total = REWARD_TYPES.reduce((s, r) => s + r.weight, 0);
  let n = Math.random() * total;
  for (const r of REWARD_TYPES) { if ((n -= r.weight) <= 0) return r; }
  return REWARD_TYPES[0];
}
function rewardCode() {
  return 'WK-' + Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
}
app.post('/api/reward/issue', async (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const now = Date.now();
  const d = await readRewards();
  const mine = d.issued.filter((r) => r.user === user);
  const last = mine.sort((a, b) => b.at - a.at)[0];
  const lastWait = last?.waitMs || 50 * 60 * 1000;
  if (last && now - last.at < lastWait) return res.json({ none: true, waitMs: lastWait - (now - last.at) });
  const type = rollReward();
  const hours = Math.max(0, Math.min(1000, Number(req.body.minutes) || 0)) / 60;
  let finalType = type;
  if (hours >= 1 && (type.type === 'badge' || type.type === 'shoutout') && Math.random() < Math.min(0.5, hours * 0.05)) {
    finalType = Math.random() < 0.25 ? REWARD_TYPES.find((t) => t.type === 'jackpot') : REWARD_TYPES.find((t) => t.type === 'premium');
  }
  const rw = { code: rewardCode(), user, type: finalType.type, label: finalType.label, at: now, claimed: false };
  if (finalType.type === 'premium' || finalType.type === 'jackpot') {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const premiumCode = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const codes = await jsonRead(codesFile);
    codes[premiumCode] = true;
    await jsonWrite(codesFile, codes);
    rw.premiumCode = premiumCode;
    rw.label = finalType.type === 'jackpot' ? 'JACKPOT - Premium code ' + premiumCode : 'FREE Premium code ' + premiumCode + ' - redeem in Settings';
  }
  d.issued.push(rw);
  if (d.issued.length > 500) d.issued = d.issued.slice(-500);
  rw.nextWaitMs = 50 * 60 * 1000 + Math.floor(Math.random() * 70 * 60 * 1000);
  await writeRewards(d);
  res.json(rw);
});
app.get('/api/config/discord-invite', (_req, res) => {
  let invite = process.env.DISCORD_INVITE || null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'discord-app.json'), 'utf8'));
    if (cfg.invite) invite = cfg.invite;
  } catch {}
  res.json({ invite });
});

app.post('/library/playlists/add-track', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const { name, track } = req.body;
  if (!name || !track || !track.id) return res.status(400).json({ error: 'Missing playlist name or track' });
  let list = [];
  list = loadPlaylists();
  const pl = list.find((p) => p.name === name && p.user === user);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  pl.tracks = pl.tracks || [];
  if (pl.tracks.find((t) => t.id === track.id)) return res.json({ ok: true, added: false, reason: 'already in playlist' });
  pl.tracks.push({ id: track.id, name: track.name, artist: track.artist, album: track.album, art: track.art, duration_ms: track.duration_ms || 0, stream_url: track.stream_url, addedAt: Date.now() });
  if (!savePlaylists(list)) return res.status(500).json({ error: 'Could not save playlist. Please try again.' });
  res.json({ ok: true, added: true, playlist: name, trackCount: pl.tracks.length });
});

app.post('/library/playlists/remove-track', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const { name, trackId } = req.body;
  let list = [];
  list = loadPlaylists();
  const pl = list.find((p) => p.name === name && p.user === user);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  pl.tracks = (pl.tracks || []).filter((t) => t.id !== trackId);
  if (!savePlaylists(list)) return res.status(500).json({ error: 'Could not save playlist. Please try again.' });
  res.json({ ok: true, trackCount: pl.tracks.length });
});

app.get('/api/rewards', async (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const d = await readRewards();
  res.json(d.issued.filter((r) => r.user === user).sort((a, b) => b.at - a.at).slice(0, 30));
});
app.get('/api/admin/rewards', adminAuth, async (req, res) => {
  const d = await readRewards();
  res.json(d.issued.sort((a, b) => b.at - a.at).slice(0, 100));
});
app.post('/api/admin/reward/claim', adminAuth, async (req, res) => {
  const code = String(req.body.code || '').toUpperCase().trim();
  const d = await readRewards();
  const rw = d.issued.find((r) => r.code === code);
  if (!rw) return res.status(404).json({ error: 'Unknown code' });
  rw.claimed = true; rw.claimedAt = Date.now();
  await writeRewards(d);
  res.json({ ok: true, reward: rw });
});


/* ============================================================
   RECOMMEND (Auto-DJ): related tracks based on artist / history
============================================================ */
app.get('/api/recommend', async (req, res) => {
  const seedArtist = String(req.query.artist || '').split(',')[0].trim();
  const seedName = String(req.query.name || '').trim();
  let pick = seedArtist;
  if (!pick) {
    try {
      const lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
      const hist = lib.history || [];
      const artists = hist.slice(-10).map((h) => (h.artist || '').split(',')[0]).filter(Boolean);
      if (artists.length) pick = artists[Math.floor(Math.random() * artists.length)];
    } catch {}
  }
  if (!pick) pick = 'top hits';
  try {
    const r = await axios.get('https://api.deezer.com/search', { params: { q: pick, limit: 25 }, timeout: 8000 });
    const tracks = (r.data.data || []).map((t) => ({
      id: 'dz-' + t.id,
      name: t.title_short || t.title,
      artist: t.artist?.name || 'Unknown',
      album: t.album?.title || '',
      art: t.album?.cover_big || t.album?.cover_medium || null,
      duration_ms: (t.duration || 0) * 1000,
      genre: null,
      preview_url: t.preview || null,
      stream_url: '/stream?q=' + encodeURIComponent((t.title_short || t.title) + ' ' + (t.artist?.name || '')),
      src: 'deezer',
    })).filter((t) => t.name.toLowerCase() !== seedName.toLowerCase());
    res.json(tracks);
  } catch { res.status(500).json({ error: 'recommend failed' }); }
});

/* ============================================================
   ERROR LOG: uncaught errors captured for the admin panel only
============================================================ */
const ERR_FILE = './data/errors.json';
function logError(kind, message) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(ERR_FILE, 'utf8')); } catch {}
    log.push({ at: Date.now(), kind, message: String(message).slice(0, 300) });
    if (log.length > 200) log = log.slice(-200);
    tryWriteJSON(ERR_FILE, log);
  } catch {}
}
const origConsoleError = console.error.bind(console);
console.error = (...args) => { try { logError('console.error', args.map(String).join(' ')); } catch {} origConsoleError(...args); };
process.on('uncaughtException', (e) => { try { logError('uncaughtException', e.message); } catch {} });
process.on('unhandledRejection', (e) => { try { logError('unhandledRejection', String(e).slice(0, 300)); } catch {} });
app.get('/api/admin/errors', adminAuth, (req, res) => {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(ERR_FILE, 'utf8')); } catch {}
  res.json(log.sort((a, b) => b.at - a.at).slice(0, 100));
});

/* ============================================================
   ARTIST PROFILE: bio pic, fans, top tracks, albums, related
============================================================ */
app.get('/api/artist', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing ?name=' });
  try {
    const ar = await axios.get('https://api.deezer.com/search/artist', { params: { q: name, limit: 1 }, timeout: 8000 });
    const a = ar.data.data?.[0];
    if (!a) return res.status(404).json({ error: 'Artist not found' });
    const [top, albums, related] = await Promise.all([
      axios.get(`https://api.deezer.com/artist/${a.id}/top`, { params: { limit: 40 }, timeout: 8000 }).catch(() => ({ data: { data: [] } })),
      axios.get(`https://api.deezer.com/artist/${a.id}/albums`, { params: { limit: 24 }, timeout: 8000 }).catch(() => ({ data: { data: [] } })),
      axios.get(`https://api.deezer.com/artist/${a.id}/related`, { params: { limit: 8 }, timeout: 8000 }).catch(() => ({ data: { data: [] } })),
    ]);
    const mapTrack = (t) => ({
      id: 'dz-' + t.id, name: t.title_short || t.title, artist: t.artist?.name || a.name,
      album: t.album?.title || '', art: t.album?.cover_big || t.album?.cover_medium || null,
      duration_ms: (t.duration || 0) * 1000, preview_url: t.preview || null,
      stream_url: '/stream?q=' + encodeURIComponent((t.title_short || t.title) + ' ' + (t.artist?.name || a.name)),
      src: 'deezer',
    });
    res.json({
      artist: { name: a.name, picture: a.picture_big || a.picture_medium || null, fans: a.nb_fan || 0, link: a.link || '' },
      topTracks: (top.data.data || []).map(mapTrack),
      albums: (albums.data.data || []).map((al) => ({ id: al.id, title: al.title, cover: al.cover_big || al.cover_medium || null, year: al.release_date ? al.release_date.slice(0, 4) : '' })),
      related: (related.data.data || []).map((r2) => ({ name: r2.name, picture: r2.picture_medium || null, fans: r2.nb_fan || 0 })).slice(0, 8),
    });
  } catch (e) { res.status(500).json({ error: 'Artist lookup failed' }); }
});
app.get('/api/album', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'missing ?id=' });
  try {
    const r = await axios.get(`https://api.deezer.com/album/${id}`, { timeout: 8000 });
    const al = r.data;
    res.json({
      title: al.title, cover: al.cover_big || al.cover_medium || null, year: al.release_date ? al.release_date.slice(0, 4) : '',
      artist: al.artist?.name || '', tracks: (al.tracks?.data || []).map((t) => ({
        id: 'dz-' + t.id, name: t.title_short || t.title, artist: t.artist?.name || al.artist?.name || '',
        album: al.title, art: al.cover_big || al.cover_medium || null, duration_ms: (t.duration || 0) * 1000,
        stream_url: '/stream?q=' + encodeURIComponent((t.title_short || t.title) + ' ' + (t.artist?.name || '')),
        src: 'deezer',
      })),
    });
  } catch { res.status(500).json({ error: 'Album lookup failed' }); }
});
/* ============================================================
   LYRICS: lrclib.net (free, real-time synced lyrics)
============================================================ */
app.get('/lyrics', async (req, res) => {
  const { artist, track } = req.query;
  if (!artist || !track) return res.status(400).json({ error: 'Missing ?artist= or ?track=' });

  const pick = (d) => ({ synced: d?.syncedLyrics || null, plain: d?.plainLyrics || null });
  try {
    const response = await axios.get('https://lrclib.net/api/get', {
      params: { artist_name: artist, track_name: track },
      timeout: 10000,
    });
    const out = pick(response.data);
    if (out.synced || out.plain) return res.json(out);
  } catch { /* fall through to search */ }

  /* fallback: lrclib search — grabs the closest match */
  try {
    const response = await axios.get('https://lrclib.net/api/search', {
      params: { q: `${track} ${artist}`, limit: 5 },
      timeout: 10000,
    });
    const best = (response.data || []).find((x) => x.syncedLyrics || x.plainLyrics);
    return res.json(pick(best));
  } catch { /* nothing found */ }
  res.json({ synced: null, plain: null });
});

/* ============================================================
   AUDIO RESOLVER: YouTube via bundled yt-dlp (free, full songs)
============================================================ */
const ytdlp = require('youtube-dl-exec');

/* ---------- stream resolution cache (instant replay + search warm-up) ----------
   yt-dlp takes ~10s per lookup. Cache the resolved audio URL in memory and on
   disk, dedupe concurrent lookups, and warm the top search results serially so
   the first click usually hits cache. Googlevideo URLs carry an `expire` param;
   cached entries are retired 2 minutes before upstream expiry. */
const STREAM_CACHE_FILE = path.join(__dirname, 'data', 'stream-cache.json');
const STREAM_CACHE_TTL = Math.max(30, Math.min(720, Number(process.env.STREAM_CACHE_TTL_MIN) || 120)) * 60 * 1000;
const STREAM_CACHE_MAX = Math.max(50, Math.min(10000, Number(process.env.STREAM_CACHE_MAX) || 2000));
const STREAM_WARM_MAX = Math.max(4, Math.min(200, Number(process.env.STREAM_WARM_MAX) || 40));
const streamCache = new Map();
const streamPending = new Map();
const streamStats = { hits: 0, misses: 0, dedupes: 0, warmed: 0, fallbacks: 0, evictions: 0 };
const streamFallback = require('./stream-fallback');
try {
  const saved = JSON.parse(fs.readFileSync(STREAM_CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) {
    if (v && v.expiresAt > Date.now()) streamCache.set(k, v);
  }
} catch {}
let streamCacheDirty = false;
function pruneStreamCache(force) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of streamCache) {
    if (!v || !(v.expiresAt > now) || (v.data && audioUrlExpiry(v.data.audio_url) <= now)) {
      streamCache.delete(k);
      changed = true;
    }
  }
  if (changed) streamCacheDirty = true;
  if (force && changed) persistStreamCache();
  return changed;
}
function persistStreamCache() {
  if (!streamCacheDirty) return;
  streamCacheDirty = false;
  pruneStreamCache(false);
  try {
    const obj = {};
    for (const [k, v] of streamCache) if (v.expiresAt > Date.now()) obj[k] = v;
    fs.writeFileSync(STREAM_CACHE_FILE, JSON.stringify(obj));
  } catch {}
}
setInterval(() => persistStreamCache(), 30000).unref();
setInterval(() => pruneStreamCache(true), 60000).unref();
const streamKey = (q) => String(q || '').trim().replace(/\s+/g, ' ').toLowerCase();
function audioUrlExpiry(url) {
  try {
    const sec = Number(new URL(url).searchParams.get('expire'));
    return sec > 0 ? sec * 1000 : Infinity;
  } catch { return Infinity; }
}
function streamExpiry(data) {
  let exp = Date.now() + STREAM_CACHE_TTL;
  const urlExp = audioUrlExpiry(data.audio_url);
  if (Number.isFinite(urlExp)) exp = Math.min(exp, urlExp - 120000);
  return exp;
}
const RETRYABLE_STREAM_ERROR = /sign in to confirm|bot|403|429|temporarily unavailable|requested format is not available|unable to extract|timeout|timed out|connection reset|http error 5\d\d/i;
async function resolveFreshStream(query) {
  const attempts = [
    { q: 'ytsearch1:' + query + ' audio' },
    { q: 'ytsearch1:' + query },
    { q: 'ytsearch3:' + query + ' audio' },
  ];
  let lastErr = null;
  let botBlocked = false;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const searchResults = await ytdlp(attempts[i].q, {
        dumpSingleJson: true,
        noWarnings: true, ...(fs.existsSync('/var/lib/ytdlp/cookies.txt') ? { cookies: '/var/lib/ytdlp/cookies.txt' } : {}),
      });
      const videos = (searchResults && searchResults.entries) || (searchResults && searchResults.id ? [searchResults] : []);
      for (const video of videos) {
        const audioFormats = (video.formats || []).filter(
          (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url
        );
        audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
        const best = audioFormats[0];
        if (!best) continue;
        return {
          title: video.title,
          duration: video.duration,
          audio_url: best.url,
          proxied_url: `/audio?u=${encodeURIComponent(best.url)}`,
          bitrate: best.abr,
          ext: best.ext,
          video_id: video.id,
          ...(i ? { retry: i } : {}),
        };
      }
      lastErr = new Error(videos.length ? 'No audio stream found' : 'No YouTube result found');
      if (i === attempts.length - 1) break; // fall through to fallback sources
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      if (/sign in to confirm|bot/i.test(msg)) { botBlocked = true; break; }
      if (!RETRYABLE_STREAM_ERROR.test(msg)) break;
      if (i === attempts.length - 1) break;
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  const reason = String(lastErr && lastErr.message || lastErr || 'resolve failed').slice(0, 160);
  console.error('Stream resolve failed after retries: ' + reason);

  // Auto-healing: privacy frontends, then short previews, then peer rotation
  // (triggered from noteBotFailure). A fallback result is cached like a normal hit.
  try {
    const fb = await streamFallback.resolve(query, reason);
    if (fb && fb.audio_url) {
      streamStats.fallbacks++;
      return { ...fb, cache: 'fallback', fallbackReason: reason };
    }
  } catch (e) {
    console.error('Stream fallback failed: ' + (e && e.message || e));
  }
  alerts.record('stream-failure', 'critical', 'All stream sources failed for a track', { query, reason });
  return {
    error: botBlocked
      ? 'Stream unavailable — YouTube is blocking this track right now'
      : 'Stream unavailable right now',
    status: 502,
  };
}
function getStream(query) {
  const key = streamKey(query);
  pruneStreamCache(false);
  const hit = streamCache.get(key);
  if (hit && hit.expiresAt > Date.now() && audioUrlExpiry(hit.data.audio_url) > Date.now()) {
    streamStats.hits++;
    return Promise.resolve({ ...hit.data, cache: 'hit' });
  }
  if (hit) { streamCache.delete(key); streamCacheDirty = true; }
  if (streamPending.has(key)) {
    streamStats.dedupes++;
    return streamPending.get(key);
  }
  const p = resolveFreshStream(query).then((data) => {
    if (data.error) return data;
    streamStats.misses++;
    const rec = { data, expiresAt: streamExpiry(data) };
    if (rec.expiresAt <= Date.now()) return { ...data, cache: 'miss' };
    streamCache.set(key, rec);
    streamCacheDirty = true;
    if (streamCache.size > STREAM_CACHE_MAX) {
      let oldest = null;
      for (const [k, v] of streamCache) {
        if (!oldest || v.expiresAt < oldest[1].expiresAt) oldest = [k, v];
      }
      if (oldest) { streamCache.delete(oldest[0]); streamStats.evictions++; }
    }
    return { ...data, cache: 'miss' };
  }).finally(() => streamPending.delete(key));
  streamPending.set(key, p);
  return p;
}
const warmQueue = [];
let warming = false;
function warmStream(q) {
  const key = streamKey(q);
  const hit = streamCache.get(key);
  if (!key || (hit && hit.expiresAt > Date.now() && audioUrlExpiry(hit.data.audio_url) > Date.now()) || streamPending.has(key) || warmQueue.includes(key)) return;
  warmQueue.push(key);
  if (warmQueue.length > STREAM_WARM_MAX) warmQueue.shift();
  if (!warming) { warming = true; setImmediate(drainWarmQueue); }
}
async function drainWarmQueue() {
  while (warmQueue.length) {
    const q = warmQueue.shift();
    try {
      const r = await getStream(q);
      if (!r || !r.error) streamStats.warmed++;
    } catch {}
  }
  warming = false;
}

/* Small observability endpoint for the stream resolver cache. */
app.get('/api/stream-cache/stats', (req, res) => {
  let oldest = null;
  for (const [k, v] of streamCache) {
    if (!oldest || v.expiresAt < oldest.expiresAt) oldest = { key: k, expiresAt: v.expiresAt };
  }
  res.json({
    entries: streamCache.size,
    pending: streamPending.size,
    queued: warmQueue.length,
    max: STREAM_CACHE_MAX,
    hits: streamStats.hits,
    misses: streamStats.misses,
    dedupes: streamStats.dedupes,
    warmed: streamStats.warmed,
    fallbacks: streamStats.fallbacks,
    evictions: streamStats.evictions,
    oldestExpiresAt: oldest && oldest.expiresAt,
    fallbackConfig: streamFallback.stats(),
  });
});

/* Ask the server to background-warm a specific query (used for next-in-queue
   prefetch from the client). Cheap and idempotent. */
app.post('/api/stream-cache/warm', (req, res) => {
  const q = String((req.body && req.body.q) || req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });
  warmStream(q.slice(0, 200));
  res.json({ ok: true, queued: warmQueue.length });
});

/* Admin-only operational alert feed (session-based, matches /admin/api/*). */
app.get('/admin/api/alerts', (req, res) => {
  try {
    const u = auth.userFromReq(req);
    if (!u || !u.account || u.account.role !== 'admin') return res.status(403).json({ msg: 'no' });
    res.json(alerts.list(req.query.limit));
  } catch { res.status(500).json({ msg: 'error' }); }
});
app.post('/admin/api/alerts/clear', (req, res) => {
  try {
    const u = auth.userFromReq(req);
    if (!u || !u.account || u.account.role !== 'admin') return res.status(403).json({ msg: 'no' });
    res.json(alerts.clear());
  } catch { res.status(500).json({ msg: 'error' }); }
});

/* Pre-warm the most recently played tracks shortly after boot so the first
   click of a familiar song is instant. Uses the existing serialized warm queue. */
setTimeout(() => {
  try {
    const lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
    const queries = [];
    for (const h of (lib.history || []).slice(-40).reverse()) {
      let q = '';
      try { q = h.stream_url ? new URL(h.stream_url, 'http://localhost').searchParams.get('q') : ''; } catch {}
      q = q || [h.name, h.artist].filter(Boolean).join(' ');
      if (!q || queries.includes(streamKey(q))) continue;
      queries.push(streamKey(q));
      if (queries.length >= 5) break;
    }
    for (const q of queries) warmStream(q);
  } catch {}
}, 5000);

/* ============================================================
   SPOTIFY (client-credentials, app-level search — no login popup)
   Keys come from .env: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
============================================================ */
let spToken = null, spTokenAt = 0;
async function getSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;
  if (spToken && Date.now() - spTokenAt < 3300 * 1000) return spToken;
  try {
    const r = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      {
        auth: { username: process.env.SPOTIFY_CLIENT_ID, password: process.env.SPOTIFY_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });
    spToken = r.data.access_token; spTokenAt = Date.now();
    return spToken;
  } catch (e) { console.error('Spotify token failed:', e.message); return null; }
}

app.get('/stream', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const data = await getStream(query);
    if (data.error) return res.status(data.status || 500).json({ error: data.error });
    res.set('X-WP-Stream-Cache', data.cache || 'miss');
    res.json(data);
  } catch (error) {
    console.error('Stream Error:', error.message);
    res.status(500).json({ error: 'Could not get audio stream' });
  }
});

/* ============================================================
   RESOLVE: any YouTube / SoundCloud page URL -> best audio
   Used by SoundCloud search results + direct link imports.
============================================================ */
app.get('/resolve', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const info = await ytdlp(url, { dumpSingleJson: true, noWarnings: true, ...(fs.existsSync('/var/lib/ytdlp/cookies.txt') ? { cookies: '/var/lib/ytdlp/cookies.txt' } : {}) });
    const audioFormats = (info.formats || []).filter(
      (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const best = audioFormats[0];
    if (!best || !best.url) return res.status(404).json({ error: 'No audio stream found' });

    res.json({
      title: info.title,
      duration: info.duration,
      audio_url: best.url,
      proxied_url: `/audio?u=${encodeURIComponent(best.url)}`,
      bitrate: best.abr,
      ext: best.ext,
      extractor: info.extractor_key,
      video_id: info.id || null,
      title: info.title,
    });
  } catch (error) {
    console.error('Resolve Error:', error.message);
    res.status(500).json({ error: 'Could not resolve that link' });
  }
});

/* ============================================================
   AUDIO PROXY: streams remote audio through us (enables EQ)
   Supports Range requests so seeking works.
============================================================ */
app.get('/audio', async (req, res) => {
  const { u, range: skipRange } = req.query;
  if (!u) return res.status(400).json({ error: 'Missing ?u=' });
  let target;
  try { target = new URL(String(u)); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (target.protocol !== 'https:' || target.username || target.password) {
    return res.status(400).json({ error: 'Invalid audio URL' });
  }
  if (net.isIP(target.hostname) && blockedIP(target.hostname)) {
    return res.status(400).json({ error: 'Blocked audio host' });
  }

  // Signed googlevideo URLs are bound to the tunnel egress IP. Fetch them as
  // UID 999 (ytdlp) so this proxy uses the same Mullvad split tunnel.
  const range = !skipRange && req.headers.range ? String(req.headers.range) : '';
  const helper = path.join(__dirname, 'audio-proxy-helper.js');
  const child = spawn('/usr/bin/setpriv', [
    '--reuid=ytdlp', '--regid=ytdlp', '--init-groups',
    'env', 'HOME=/var/lib/ytdlp', '/usr/bin/node', helper, target.toString(), range,
  ], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = Buffer.alloc(0);
  let parsed = false;
  let stderr = '';
  let clientClosed = false;
  child.stderr.on('data', (c) => {
    stderr += c.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  child.stdout.on('data', (chunk) => {
    if (clientClosed) return;
    if (parsed) { res.write(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return;
    const line = buf.slice(0, nl).toString('utf8');
    const rest = buf.slice(nl + 1);
    buf = Buffer.alloc(0);
    parsed = true;
    let meta = null;
    try { meta = JSON.parse(line); } catch { meta = null; }
    if (!meta || !meta.headers) {
      if (!res.headersSent) res.status(502).json({ error: 'Audio proxy failed' });
      child.kill();
      return;
    }
    const h = meta.headers;
    if (h['content-type']) res.setHeader('Content-Type', h['content-type']);
    if (h['content-length']) res.setHeader('Content-Length', h['content-length']);
    if (h['content-range']) res.setHeader('Content-Range', h['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.status(h['content-range'] ? 206 : (meta.status || 200));
    if (rest.length) res.write(rest);
  });
  child.on('error', (error) => {
    console.error('Audio Proxy Error:', error.message);
    if (!res.headersSent) res.status(502).json({ error: 'Audio proxy failed' });
  });
  child.on('close', (code) => {
    if (clientClosed) return;
    if (code !== 0 && !res.headersSent) {
      console.error('Audio Proxy Error:', stderr.trim() || `exit ${code}`);
      res.status(502).json({ error: 'Audio proxy failed' });
    } else if (res.headersSent) {
      res.end();
    }
  });
  res.on('close', () => {
    clientClosed = true;
    if (!child.killed) child.kill();
  });
});

/* ============================================================
   PLAYLIST IMPORT: public Spotify playlist links (no auth)
   Parses the public /embed page which includes the track list.
============================================================ */
app.get('/import', async (req, res) => {
  const url = String(req.query.url || '');
  const m = url.match(/(playlist|album|artist)\/([A-Za-z0-9]+)/);
  if (!m) return res.status(400).json({ error: 'Paste a Spotify playlist/album link' });
  const [, kind, id] = m;

  try {
    const { data: html } = await axios.get(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000,
    });

    const scriptMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    if (!scriptMatch) return res.status(404).json({ error: 'Could not read playlist data' });

    const json = JSON.parse(scriptMatch[1]);
    const entity = json?.props?.pageProps?.state?.data?.entity;
    if (!entity?.trackList) return res.status(404).json({ error: 'No tracks found' });

    const tracks = entity.trackList.map((t, idx) => {
      const art = t.coverArt?.sources?.slice(-1)[0]?.url
        || entity.coverArt?.sources?.slice(-1)[0]?.url
        || null;
      const name = t.title || '';
      const artist = t.subtitle || '';
      // embed "duration" is already in milliseconds
      const durMs = (t.duration || 0) > 10000 ? t.duration : (t.duration || 0) * 1000;
      return {
        id: `${t.uri || `imp-${idx}`}-${idx}`,
        name,
        artist,
        album: '',
        art,
        duration_ms: durMs,
        preview_url: t.audioPreview?.url || null,
        stream_url: `/stream?q=${encodeURIComponent(name + ' ' + artist)}`,
      };
    });

    res.json({ name: entity.title || 'Imported', total: tracks.length, tracks });
  } catch (error) {
    console.error('Import Error:', error.message);
    res.status(500).json({ error: 'Import failed' });
  }
});

/* Health check */

/* ============================================================
   SPOTIFY OAUTH (user login - playlist + liked songs access)
   Flow: app opens /api/spotify/login (port 3000 listener) ->
   Spotify authorize -> callback exchanges code -> tokens saved.
   Requires SPOTIFY_REDIRECT_URI (default http://localhost:3000)
   to be registered in the Spotify dashboard Redirect URIs.
============================================================ */
const tokenFile = './data/spotify-token.json';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000';
const OAUTH_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read user-read-email';
let oauthApp = null;

async function saveTokens(t) {
  t.savedAt = Date.now();
  await fs.promises.writeFile(tokenFile, JSON.stringify(t, null, 2));
}
async function getUserToken() {
  let t;
  try { t = JSON.parse(await fs.promises.readFile(tokenFile, 'utf8')); } catch { return null; }
  if (!t?.access_token) return null;
  if (t.expires_at && Date.now() < t.expires_at - 30000) return t.access_token;
  if (!t.refresh_token) return null;
  try {
    const r = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
      { auth: { username: process.env.SPOTIFY_CLIENT_ID, password: process.env.SPOTIFY_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    t.access_token = r.data.access_token;
    t.expires_at = Date.now() + (r.data.expires_in || 3600) * 1000;
    if (r.data.refresh_token) t.refresh_token = r.data.refresh_token;
    await saveTokens(t);
    return t.access_token;
  } catch { return null; }
}
function mapSpotifyTrack(t) {
  return {
    id: 'sp-' + t.id,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: t.album?.images?.[0]?.url || null,
    duration_ms: t.duration_ms || 0,
    genre: null,
    preview_url: t.preview_url || null,
    stream_url: '/stream?q=' + encodeURIComponent(t.name + ' ' + (t.artists?.[0]?.name || '')),
    src: 'spotify',
  };
}

/* tiny listener on the redirect port - catches the OAuth callback */
function startOAuthListener() {
  if (oauthApp) return;
  oauthApp = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname === '/api/spotify/login') {
      const params = new URLSearchParams({
        client_id: process.env.SPOTIFY_CLIENT_ID || '',
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: OAUTH_SCOPES,
        show_dialog: 'false',
      });
      res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + params.toString() });
      return res.end();
    }
    if (url.searchParams.get('code')) {
      const code = url.searchParams.get('code');
      try {
        const r = await axios.post('https://accounts.spotify.com/api/token',
          new URLSearchParams({
            grant_type: 'authorization_code', code,
            redirect_uri: REDIRECT_URI,
          }).toString(),
          { auth: { username: process.env.SPOTIFY_CLIENT_ID, password: process.env.SPOTIFY_CLIENT_SECRET },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
        await saveTokens({
          access_token: r.data.access_token,
          refresh_token: r.data.refresh_token,
          expires_at: Date.now() + (r.data.expires_in || 3600) * 1000,
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<body style="background:#0d0b14;color:#a855f7;font-family:sans-serif;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h1>Connected!</h1><p>Spotify linked - returning to Wicked Player...</p><script>setTimeout(function(){location.href="wicked://connected";},1200);</script></div></body>');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<body style="background:#0d0b14;color:#f66;font-family:sans-serif"><h1>Spotify link failed</h1><p>' + (e.message || '') + '</p></body>');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<body style="background:#0d0b14;color:#a855f7;font-family:sans-serif"><h1>Wicked Player - Spotify link service</h1><p>Waiting for authorization...</p></body>');
  });
  oauthApp.listen(3000, '127.0.0.1', () => console.log('Spotify OAuth listener on http://localhost:3000'));
  oauthApp.on('error', (e) => console.log('OAuth listener skipped:', e.message));
}
startOAuthListener();

/* main-server endpoints (read the saved token) */
app.get('/api/spotify/me', async (req, res) => {
  const tok = await getUserToken();
  if (!tok) return res.json({ connected: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + tok }, timeout: 8000 });
    res.json({ connected: true, name: r.data.display_name || 'you' });
  } catch { res.json({ connected: false }); }
});
app.get('/api/spotify/playlists', async (req, res) => {
  const tok = await getUserToken();
  if (!tok) return res.status(401).json({ error: 'Connect Spotify first' });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/playlists', { params: { limit: 50 }, headers: { Authorization: 'Bearer ' + tok }, timeout: 10000 });
    res.json((r.data.items || []).map((p) => ({
      id: p.id, name: p.name, owner: p.owner?.display_name || '',
      art: p.images?.[0]?.url || null, total: p.tracks?.total || 0,
    })));
  } catch (e) { res.status(500).json({ error: 'Could not load playlists' }); }
});
app.get('/api/spotify/playlist/:id', async (req, res) => {
  const tok = await getUserToken();
  if (!tok) return res.status(401).json({ error: 'Connect Spotify first' });
  try {
    const out = [];
    let url = 'https://api.spotify.com/v1/playlists/' + encodeURIComponent(req.params.id) + '/tracks?limit=100';
    for (let page = 0; page < 5 && url; page++) {
      const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + tok }, timeout: 12000 });
      for (const it of r.data.items || []) {
        if (it.track) out.push(mapSpotifyTrack(it.track));
      }
      url = r.data.next || null;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Could not load playlist tracks' }); }
});
app.get('/api/spotify/liked', async (req, res) => {
  const tok = await getUserToken();
  if (!tok) return res.status(401).json({ error: 'Connect Spotify first' });
  try {
    const out = [];
    let url = 'https://api.spotify.com/v1/me/tracks?limit=50';
    for (let page = 0; page < 4 && url; page++) {
      const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + tok }, timeout: 12000 });
      for (const it of r.data.items || []) { if (it.track) out.push(mapSpotifyTrack(it.track)); }
      url = r.data.next || null;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Could not load liked songs' }); }
});
/* ============================================================
  /* ============================================================
     WEB UI - serve the full Wicked Player in the browser.
     Login-gated: "/" serves login page when logged out.
  ============================================================ */
  const UI_CANDIDATES = [
    path.join(__dirname, '..', 'wicked-frontend', 'dist'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app-ui') : null,
    path.join(__dirname, 'app-ui'),
  ].filter(Boolean);
  const UI_DIR = UI_CANDIDATES.find((c) => fs.existsSync(path.join(c, 'index.html'))) || UI_CANDIDATES[0];
  app.use(express.static(UI_DIR, { index: false, maxAge: '1h', setHeaders: (res, p) => {
    const f = path.basename(p).toLowerCase();
    if (p.endsWith('.html') || f.startsWith('enhance.') || f.startsWith('account-chip.')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  } }));

  /* genre cover art for the genres page (public - just image urls) */
  const GENRE_ART_CACHE_FILE = path.join(__dirname, 'data', 'genre-art.json');
  const genreArtMem = {};
  try { Object.assign(genreArtMem, JSON.parse(fs.readFileSync(GENRE_ART_CACHE_FILE, 'utf8'))); } catch {}
  app.get('/genre-art', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'missing name' });
    if (genreArtMem[name]) return res.json({ name, art: genreArtMem[name] });
    try {
      const r = await axios.get('https://itunes.apple.com/search', {
        params: { term: name + ' hits', media: 'music', entity: 'album', limit: 6 },
        timeout: 8000,
      });
      const results = (r.data.results || []).filter((a) => a.artworkUrl100);
      const pick = results.find((a) => (a.collectionName || '').toLowerCase().includes(name.toLowerCase())) || results[0];
      const art = pick ? pick.artworkUrl100.replace('100x100', '300x300') : null;
      if (art) {
        genreArtMem[name] = art;
        try {
          fs.mkdirSync(path.dirname(GENRE_ART_CACHE_FILE), { recursive: true });
          fs.writeFileSync(GENRE_ART_CACHE_FILE, JSON.stringify(genreArtMem));
        } catch {}
      }
      res.json({ name, art });
    } catch { res.json({ name, art: genreArtMem[name] || null }); }
  });

  /* "/" behind the login gate */
  app.get('/', auth.gateHome(() => path.join(UI_DIR, 'index.html')));

  /* SPA fallback - also gated */
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/socket.io') && !req.path.startsWith('/api')) {
      if (req.query.wpoverlay === '1') return res.sendFile(path.join(UI_DIR, 'index.html'));
      const u = auth.userFromReq(req);
      if (!u) return res.redirect('/');
      const ban = auth.isBannedNow(u);
      if (ban) return res.redirect('/');
      return res.sendFile(path.join(UI_DIR, 'index.html'));
    }
    next();
  });

app.get('/api/status', (req, res) => res.json({ status: 'Wicked server is running (free mode +)' }));

const PORT = process.env.PORT || 5000;
server.on('error', (e) => {
  console.error(`SERVER ERROR: ${e.code || ''} ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error('Port 5000 already in use - another instance is running. Exiting in 2s.');
    setTimeout(() => process.exit(1), 2000);
  }
});
server.listen(PORT, () => {
  console.log(`Wicked Server running on port ${PORT} (library + import + EQ proxy enabled)`);
});
