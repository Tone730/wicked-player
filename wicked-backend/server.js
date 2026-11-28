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
const { readJSON, readJSONStrict, atomicWriteJSON, tryWriteJSON } = require('./lib/store');
const {
  readCommunityStore,
  readCodesStore,
  readRewardsStore,
} = require('./lib/premium-store');
const {
  canonicalGenreName,
  collectWithin,
  genreDefinition,
  genreMatches,
  isFullStream,
  makeStreamUrl,
  mergeTracks,
  pickBestMatchingTrack,
  safePreviewUrl,
  trackMatchScore,
} = require('./lib/music-catalog');
const accessLog = require('./lib/access-log');
const { resolveFastestWithPreview, resolveProviderPreview } = require('./lib/provider-preview');
const {
  PremiumRedemptionError,
  redeemPremiumReward,
} = require('./lib/premium-redemptions');
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
/* Premium grants and automatic redemptions are pushed only to signed-in
   admins, so the redemption log updates without waiting for a page refresh. */
auth.setPremiumRedemptionEmitter((row) => {
  try { io.to('admins').emit('premium:redemption', row); } catch {}
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
    const info = await runYtDlpExclusive(
      url,
      ytdlpFlags({ dumpSingleJson: true }),
      ytdlpOptions(20000),
    );
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
   CATALOG: bounded text search + true genre browsing
   ============================================================ */
const CATALOG_RESPONSE_BUDGET_MS = Math.max(500, Math.min(5000,
  Number(process.env.CATALOG_RESPONSE_BUDGET_MS) || 2500));
const PROVIDER_TIMEOUT_MS = Math.max(1000, Math.min(8000,
  Number(process.env.CATALOG_PROVIDER_TIMEOUT_MS) || 3500));
const GENRE_CACHE_TTL_MS = Math.max(1, Math.min(1800,
  Number(process.env.GENRE_CACHE_TTL_MIN) || 10)) * 60 * 1000;
const PREVIEW_CACHE_TTL_MS = Math.max(5, Math.min(180,
  Number(process.env.PREVIEW_CACHE_TTL_MIN) || 45)) * 60 * 1000;
const genreCache = new Map();
const previewCache = new Map();
const providerPreviewPending = new Map();

function catalogKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function streamQueryFor(name, artist) {
  return [name, artist].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
function rememberPreview(query, previewUrl, title, duration) {
  const safe = safePreviewUrl(previewUrl);
  if (!safe) return null;
  const key = catalogKey(query);
  if (!key) return null;
  const data = {
    title: title || '',
    duration: duration || 30,
    audio_url: safe,
    proxied_url: `/audio?u=${encodeURIComponent(safe)}`,
    bitrate: 128,
    ext: /\.m4a(?:$|\?)/i.test(safe) ? 'm4a' : 'mp3',
    source: 'provider-preview',
    preview: true,
    expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
  };
  previewCache.set(key, data);
  if (previewCache.size > 1000) {
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
  return data;
}
function previewFor(query) {
  const key = catalogKey(query);
  const hit = previewCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    previewCache.delete(key);
    return null;
  }
  const { expiresAt, ...data } = hit;
  return data;
}

/* Provider lookups are short and cheap compared with yt-dlp. When playback
   starts from a library, radio, or direct link (and therefore has no preview
   in the request), resolve one concurrently with the full stream. The preview
   is returned as soon as it is available; the yt-dlp job continues and caches
   the complete stream for the upgrade request. */
async function providerPreviewJson(provider, params, timeoutMs) {
  if (provider === 'deezer') {
    const response = await axios.get('https://api.deezer.com/search', { params, timeout: timeoutMs });
    return response.data;
  }
  const response = await axios.get('https://itunes.apple.com/search', { params, timeout: timeoutMs });
  return response.data;
}

function lookupProviderPreview(query) {
  const key = catalogKey(query);
  if (!key) return Promise.resolve(null);
  const cached = previewFor(query);
  if (cached) return Promise.resolve(cached);
  const existing = providerPreviewPending.get(key);
  if (existing) return existing;

  const promise = resolveProviderPreview(query, {
    getJson: providerPreviewJson,
    timeoutMs: 2500,
  }).then((preview) => {
    if (!preview) return null;
    return rememberPreview(query, preview.audio_url, preview.title, preview.duration) || preview;
  }).catch(() => null).finally(() => {
    if (providerPreviewPending.get(key) === promise) providerPreviewPending.delete(key);
  });
  providerPreviewPending.set(key, promise);
  return promise;
}
function mapItunesTrack(t, genre = null) {
  const name = t.trackName || '';
  const artist = t.artistName || '';
  const query = streamQueryFor(name, artist);
  const preview = t.previewUrl || null;
  rememberPreview(query, preview, name, 30);
  return {
    id: `it-${t.trackId}`,
    name,
    artist,
    album: t.collectionName,
    art: t.artworkUrl100 ? t.artworkUrl100.replace('100x100', '600x600') : null,
    duration_ms: t.trackTimeMillis,
    genre: genre || t.primaryGenreName || null,
    preview_url: preview,
    stream_url: makeStreamUrl(query, preview),
    src: 'itunes',
  };
}
function mapDeezerTrack(t) {
  const name = t.title_short || t.title || '';
  const artist = t.artist?.name || 'Unknown';
  const query = streamQueryFor(name, artist);
  const preview = t.preview || null;
  rememberPreview(query, preview, name, 30);
  return {
    id: `dz-${t.id}`,
    name,
    artist,
    album: t.album?.title || '',
    art: t.album?.cover_big || t.album?.cover_medium || null,
    duration_ms: (t.duration || 0) * 1000,
    genre: null,
    preview_url: preview,
    stream_url: makeStreamUrl(query, preview),
    src: 'deezer',
  };
}
function mapSpotifyCatalogTrack(t, genre = null) {
  const name = t.name || '';
  const artists = (t.artists || []).map((a) => a.name).filter(Boolean);
  const artist = artists.join(', ');
  const query = streamQueryFor(name, artists[0] || artist);
  const preview = t.preview_url || null;
  rememberPreview(query, preview, name, 30);
  return {
    id: `sp-${t.id}`,
    name,
    artist,
    album: t.album?.name || '',
    art: t.album?.images?.[0]?.url || null,
    duration_ms: t.duration_ms || 0,
    genre,
    preview_url: preview,
    stream_url: makeStreamUrl(query, preview),
    src: 'spotify',
  };
}
function attachExactPreview(track) {
  try {
    const query = new URL(track.stream_url, 'http://localhost').searchParams.get('q');
    const preview = previewFor(query);
    if (!preview) return;
    track.preview_url = preview.audio_url;
    track.stream_url = makeStreamUrl(query, preview.audio_url);
  } catch {}
}

app.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ error: 'Missing ?q= search term' });

  const one = (promise) => promise.catch(() => []);

  /* --- iTunes (previews + metadata, fast, no auth) --- */
  const itunesP = one(axios.get('https://itunes.apple.com/search', {
    params: { term: query, media: 'music', entity: 'song', limit: 25 },
    timeout: PROVIDER_TIMEOUT_MS,
  }).then((response) => (response.data.results || []).map((track) => mapItunesTrack(track))));

  /* --- Deezer (keyless, huge catalog, 30s previews) --- */
  const deezerP = one(axios.get('https://api.deezer.com/search', {
    params: { q: query, limit: 25 },
    timeout: PROVIDER_TIMEOUT_MS,
  }).then((response) => (response.data.data || []).map(mapDeezerTrack)));

  /* --- Spotify (official catalog via client-credentials, optional) --- */
  const spotifyP = one(getSpotifyToken().then(async (tok) => {
    if (!tok) return [];
    try {
      const r = await axios.get('https://api.spotify.com/v1/search', {
        params: { q: query, type: 'track', limit: 10, market: 'US' },
        headers: { Authorization: `Bearer ${tok}` },
        timeout: PROVIDER_TIMEOUT_MS,
      });
      return (r.data.tracks?.items || []).map((t) => mapSpotifyCatalogTrack(t));
    } catch (e) {
      console.error(`Spotify search failed: ${e.message}`);
      return [];
    }
  }));

  /* Return as soon as the useful providers answer. A slow optional provider
     must never hold the whole search hostage. */
  const [it, dz, sp] = await collectWithin(
    [itunesP, deezerP, spotifyP], CATALOG_RESPONSE_BUDGET_MS);
  const merged = mergeTracks([sp, it, dz], query);
  if (!merged.length) return res.status(503).json({ error: 'Search temporarily unavailable' });
  merged.forEach(attachExactPreview);

  res.set('Cache-Control', 'private, max-age=30');
  res.json(merged);

  /* Warm only the most likely click. The queue is serialized and yields to
     foreground playback, so search never competes with the selected track. */
  const first = merged[0];
  if (first) {
    try {
      const queryToWarm = new URL(first.stream_url, 'http://localhost').searchParams.get('q');
      setImmediate(() => warmStream(queryToWarm));
    } catch {}
  }
});

/* Genre cards use a dedicated endpoint and a curated provider query from
   the shared catalog vocabulary. Spotify genre filters are used where they
   exist; iTunes results are accepted only when their own primaryGenreName
   matches the selected genre. */
app.get('/genre', async (req, res) => {
  const requested = canonicalGenreName(req.query.genre || req.query.q);
  const definition = genreDefinition(requested);
  if (!requested || !definition) return res.status(400).json({ error: 'Unknown genre' });

  const cacheKey = catalogKey(requested);
  const cached = genreCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set('Cache-Control', 'private, max-age=60');
    return res.json(cached.data);
  }

  const spotifyQuery = definition.spotifyQuery;
  const one = (promise) => promise.catch(() => []);

  const spotifyP = one(getSpotifyToken().then(async (tok) => {
    if (!tok) return [];
    try {
      const pages = await Promise.all([0, 10, 20].map(async (offset) => {
        const r = await axios.get('https://api.spotify.com/v1/search', {
          params: { q: spotifyQuery, type: 'track', limit: 10, offset, market: 'US' },
          headers: { Authorization: `Bearer ${tok}` },
          timeout: PROVIDER_TIMEOUT_MS,
        });
        return (r.data.tracks?.items || []).map((t) => mapSpotifyCatalogTrack(t, requested));
      }));
      return pages.flat();
    } catch (e) {
      console.error(`Spotify genre search failed: ${e.message}`);
      return [];
    }
  }));

  const itunesP = one(axios.get('https://itunes.apple.com/search', {
    params: { term: requested, media: 'music', entity: 'song', limit: 50 },
    timeout: PROVIDER_TIMEOUT_MS,
  }).then((response) => (response.data.results || [])
    .filter((t) => genreMatches(t.primaryGenreName, requested))
    .map((t) => mapItunesTrack(t, requested))));

  const [sp, it] = await collectWithin(
    [spotifyP, itunesP], CATALOG_RESPONSE_BUDGET_MS);
  const merged = mergeTracks([sp, it], '', 40);
  if (!merged.length) return res.status(404).json({ error: `No ${requested} tracks found` });
  merged.forEach(attachExactPreview);

  genreCache.set(cacheKey, { data: merged, expiresAt: Date.now() + GENRE_CACHE_TTL_MS });
  if (genreCache.size > 40) genreCache.delete(genreCache.keys().next().value);

  res.set('Cache-Control', 'private, max-age=60');
  res.json(merged);

  const first = merged[0];
  if (first) {
    try {
      const queryToWarm = new URL(first.stream_url, 'http://localhost').searchParams.get('q');
      setImmediate(() => warmStream(queryToWarm));
    } catch {}
  }
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
const codesFile = path.join(__dirname, 'data', 'codes.json');
const rewardsFile = path.join(__dirname, 'data', 'rewards.json');
const communityFile = path.join(__dirname, 'data', 'community.json');
function jsonRead(file) { return readJSON(file, {}); }
function jsonWrite(file, data) { atomicWriteJSON(file, data); }
/* ============================================================
   REWARDS: random drops for listening time - claim via Discord
============================================================ */
function isPremiumRewardType(type) {
  return type === 'premium' || type === 'jackpot';
}
function premiumRewardLabel(type) {
  return type === 'jackpot'
    ? 'JACKPOT - Premium redeemed automatically (7 days active)'
    : 'Premium redeemed automatically (30 days active)';
}
function readRewards() {
  /* A reward store with a broken shape is a corrupt store, not an empty one:
     replacing it with { issued: [] } would silently drop issued rewards. */
  return readRewardsStore(rewardsFile);
}
function writeRewards(d) { atomicWriteJSON(rewardsFile, d); }
function rewardRedemptionState(rewards) {
  const comm = readCommunityStore(communityFile);
  const receipts = comm && comm.premiumRedemptions && typeof comm.premiumRedemptions === 'object'
    ? comm.premiumRedemptions
    : {};
  let changed = false;
  for (const reward of rewards.issued || []) {
    if (!reward || !reward.redemptionId) continue;
    const receipt = receipts[reward.redemptionId];
    if (!receipt) continue;
    const label = premiumRewardLabel(reward.type);
    if (reward.status !== 'redeemed' || reward.autoRedeemed !== true
      || reward.redeemedAt !== receipt.redeemedAt || reward.redeemedBy !== receipt.redeemedBy
      || reward.until !== receipt.until || reward.claimed !== true
      || reward.label !== label) {
      reward.status = 'redeemed';
      reward.autoRedeemed = true;
      reward.redeemedAt = receipt.redeemedAt;
      reward.redeemedBy = receipt.redeemedBy || receipt.user;
      reward.until = receipt.until;
      reward.claimed = true;
      reward.claimedAt = reward.claimedAt || receipt.redeemedAt;
      reward.label = label;
      changed = true;
    }
  }
  return { comm, changed };
}

/* Commit a premium reward: the grant, receipt, and code-consumption marker
   land in one community write, and only then is the reward mirror updated.
   The redemption id is the idempotency key, so a retry after a lost response
   returns the original receipt instead of granting premium twice. */
function commitPremiumReward(d, rw, req, now) {
  let comm;
  let codes;
  try {
    comm = readCommunityStore(communityFile);
    codes = readCodesStore(codesFile);
  } catch (error) {
    process.stderr.write(`[rewards] store read failed: ${error && error.message || error}\n`);
    return { ok: false, status: 503, message: 'The premium store is unavailable. Please try again.' };
  }

  let result;
  try {
    result = redeemPremiumReward({
      community: comm,
      user: rw.user,
      rewardCode: rw.code,
      premiumCode: rw.premiumCode,
      type: rw.type,
      id: rw.redemptionId,
      /* The entitlement starts when the grant is committed, not when the
         reward was issued: a retry days later must still grant a full
         duration instead of a period that is already over. */
      now,
    });
  } catch (error) {
    const status = error instanceof PremiumRedemptionError ? error.status : 503;
    const message = error instanceof PremiumRedemptionError
      ? error.message
      : 'The premium reward could not be redeemed. Please try again.';
    process.stderr.write(`[rewards] automatic redemption failed: ${error && error.message || error}\n`);
    return { ok: false, status, message };
  }

  try {
    atomicWriteJSON(communityFile, comm);
  } catch (error) {
    process.stderr.write(`[rewards] community save failed: ${error && error.message || error}\n`);
    return { ok: false, status: 503, message: 'The premium reward could not be saved. Please try again.' };
  }

  const redemption = result.redemption;
  rw.status = 'redeemed';
  rw.autoRedeemed = true;
  rw.redeemedAt = redemption.redeemedAt;
  rw.redeemedBy = redemption.redeemedBy || rw.user;
  rw.until = redemption.until;
  rw.claimed = true;
  rw.claimedAt = rw.claimedAt || redemption.redeemedAt;
  rw.label = premiumRewardLabel(rw.type);
  try {
    writeRewards(d);
  } catch (error) {
    /* The grant and receipt are already committed. The rewards endpoint
       reconciles this pending mirror from the community receipt. */
    process.stderr.write(`[rewards] redeemed mirror failed: ${error && error.message || error}\n`);
  }

  codes[rw.premiumCode] = {
    type: rw.type,
    days: redemption.days,
    used: true,
    usedBy: rw.user,
    usedAt: redemption.redeemedAt,
    redemptionId: redemption.id,
  };
  try {
    jsonWrite(codesFile, codes);
  } catch (error) {
    process.stderr.write(`[rewards] code mirror failed: ${error && error.message || error}\n`);
  }
  try { auth.logRedemption(redemption); } catch {}
  try {
    auth.appendActivity('premium-reward', req, {
      code: rw.code,
      days: redemption.days,
      redemptionId: redemption.id,
      status: 'redeemed',
      autoRedeemed: true,
      redeemedAt: redemption.redeemedAt,
    });
  } catch {}
  try { io.to('admins').emit('premium:redemption', redemption); } catch {}

  return { ok: true, reward: rw, redemption };
}
  const REWARD_TYPES = [
    { type: 'badge',     label: 'Loyalty badge - show it off on your profile',      weight: 18 },
    { type: 'bonus',     label: 'Bonus soundboard pack (this week only)',           weight: 14 },
    { type: 'shoutout',  label: 'Discord shoutout from the host',                    weight: 10 },
    { type: 'skip',      label: '5 unlimited-skip boosters',                        weight: 12 },
    { type: 'premium',   label: 'FREE Premium - automatic redemption',               weight: 8  },
    { type: 'jackpot',   label: 'JACKPOT - 7-day Premium - automatic redemption',    weight: 3  },
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
app.post('/api/reward/issue', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  if (auth.isBannedNow(auth.users[user])) return res.status(403).json({ error: 'This account is banned' });
  const now = Date.now();
  let d;
  try {
    d = readRewards();
    rewardRedemptionState(d);
  } catch (error) {
    process.stderr.write(`[rewards] reward read failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward store is unavailable. Please try again.' });
  }

  /* A premium reward whose redemption never committed is retried with the
     same redemption id, so the retry grants exactly once. */
  const pending = d.issued
    .filter((r) => r && r.user === user && isPremiumRewardType(r.type)
      && (r.status === 'pending_redemption' || r.status === 'failed'))
    .sort((a, b) => b.at - a.at)[0];
  if (pending) {
    pending.status = 'pending_redemption';
    const retried = commitPremiumReward(d, pending, req, now);
    if (retried.ok) return res.json(retried.reward);
    pending.status = 'failed';
    pending.failure = retried.message;
    try { writeRewards(d); } catch {}
    return res.status(retried.status).json({ error: retried.message });
  }

  const mine = d.issued.filter((r) => r && r.user === user && r.status !== 'failed');
  const last = mine.sort((a, b) => b.at - a.at)[0];
  const lastWait = last?.nextWaitMs || last?.waitMs || 50 * 60 * 1000;
  if (last && now - last.at < lastWait) return res.json({ none: true, waitMs: lastWait - (now - last.at) });
  const type = rollReward();
  const hours = Math.max(0, Math.min(1000, Number(req.body.minutes) || 0)) / 60;
  let finalType = type;
  if (hours >= 1 && (type.type === 'badge' || type.type === 'shoutout') && Math.random() < Math.min(0.5, hours * 0.05)) {
    finalType = Math.random() < 0.25 ? REWARD_TYPES.find((t) => t.type === 'jackpot') : REWARD_TYPES.find((t) => t.type === 'premium');
  }
  let issuedCode = rewardCode();
  while (d.issued.some((reward) => reward && reward.code === issuedCode)) issuedCode = rewardCode();
  const rw = {
    code: issuedCode,
    user,
    type: finalType.type,
    label: finalType.label,
    at: now,
    claimed: false,
    status: 'issued',
  };
  const premiumReward = isPremiumRewardType(finalType.type);
  if (premiumReward) {
    let comm;
    let codes;
    try {
      comm = readCommunityStore(communityFile);
      codes = readCodesStore(codesFile);
    } catch (error) {
      process.stderr.write(`[rewards] store read failed: ${error && error.message || error}\n`);
      return res.status(503).json({ error: 'The premium store is unavailable. Please try again.' });
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
      rw.premiumCode = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (codes[rw.premiumCode] || comm.premiumCodeRedemptions?.[rw.premiumCode]);
    rw.redemptionId = crypto.randomUUID();
    rw.label = 'Premium reward - redeeming automatically...';
    rw.status = 'pending_redemption';
  }
  d.issued.push(rw);
  if (d.issued.length > 500) d.issued = d.issued.slice(-500);
  rw.nextWaitMs = 50 * 60 * 1000 + Math.floor(Math.random() * 70 * 60 * 1000);

  /* Persist the reward first. If that write fails, no premium is granted. */
  try {
    writeRewards(d);
  } catch (error) {
    process.stderr.write(`[rewards] reward save failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward could not be saved. Please try again.' });
  }

  if (!premiumReward) return res.json(rw);

  const outcome = commitPremiumReward(d, rw, req, now);
  if (!outcome.ok) {
    rw.status = 'failed';
    rw.failure = outcome.message;
    try { writeRewards(d); } catch {}
    return res.status(outcome.status).json({ error: outcome.message });
  }
  return res.json(rw);
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

app.get('/api/rewards', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  let d;
  try {
    d = readRewards();
    const state = rewardRedemptionState(d);
    if (state.changed) {
      try { writeRewards(d); } catch {}
    }
  } catch (error) {
    process.stderr.write(`[rewards] list read failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward store is unavailable. Please try again.' });
  }
  res.json(d.issued.filter((r) => r && r.user === user).sort((a, b) => b.at - a.at).slice(0, 30));
});
app.get('/api/admin/rewards', adminAuth, (req, res) => {
  let d;
  try {
    d = readRewards();
    const state = rewardRedemptionState(d);
    if (state.changed) {
      try { writeRewards(d); } catch {}
    }
  } catch (error) {
    process.stderr.write(`[rewards] admin read failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward store is unavailable. Please try again.' });
  }
  res.json(d.issued.sort((a, b) => b.at - a.at).slice(0, 100));
});
app.post('/api/admin/reward/claim', adminAuth, (req, res) => {
  const code = String(req.body.code || '').toUpperCase().trim();
  let d;
  let comm;
  try {
    d = readRewards();
    const state = rewardRedemptionState(d);
    comm = state.comm;
  } catch (error) {
    process.stderr.write(`[rewards] claim read failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward store is unavailable. Please try again.' });
  }
  const rw = d.issued.find((r) => r && r.code === code);
  if (!rw) return res.status(404).json({ error: 'Unknown code' });
  /* Only a committed receipt proves the premium was actually redeemed. */
  const receipts = comm && comm.premiumRedemptions && typeof comm.premiumRedemptions === 'object'
    ? comm.premiumRedemptions
    : {};
  const receipt = rw.redemptionId ? receipts[rw.redemptionId] : null;

  /* An automatic reward without a receipt never received its premium. It is
     retried here with the same redemption id instead of being marked as
     claimed, so it stays redeemable instead of being stranded. */
  if (rw.redemptionId && !receipt) {
    if (!rw.premiumCode) {
      return res.status(409).json({
        error: 'This reward has not been redeemed yet and cannot be redeemed automatically.',
        code: 'REWARD_NOT_REDEEMED',
      });
    }
    rw.status = 'pending_redemption';
    const retried = commitPremiumReward(d, rw, req, Date.now());
    if (!retried.ok) {
      rw.status = 'failed';
      rw.failure = retried.message;
      try { writeRewards(d); } catch {}
      return res.status(retried.status).json({ error: retried.message });
    }
    return res.json({ ok: true, alreadyRedeemed: true, reward: rw });
  }

  /* Legacy rewards (issued before automatic redemption existed) have no
     redemption id and are still claimed by hand in Discord. */
  const alreadyRedeemed = Boolean(receipt);
  rw.claimed = true;
  rw.claimedAt = rw.claimedAt || Date.now();
  rw.claimMethod = alreadyRedeemed ? 'automatic' : 'discord';
  if (!alreadyRedeemed) rw.status = 'claimed';
  try {
    writeRewards(d);
  } catch (error) {
    process.stderr.write(`[rewards] claim save failed: ${error && error.message || error}\n`);
    return res.status(503).json({ error: 'The reward claim could not be saved.' });
  }
  res.json({ ok: true, alreadyRedeemed, reward: rw });
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
const {
  createBackgroundJobRegistry,
  createClientJobRegistry,
  createClientPendingRegistry,
  createPrioritySerialQueue,
  createResolverJob,
  describeResolverError,
  isResolverBotChallenge,
  isRetryableResolverError,
} = require('./lib/stream-resolver');

/* yt-dlp child processes interfere with one another on this VPS. Running
   searches/extractions in parallel makes every job hit its deadline, while a
   serial queue resolves the same track reliably. Foreground selections take
   priority over background cache warm-ups. */
const STREAM_RESOLVER_QUEUE_MAX = Math.max(10, Math.min(500,
  Number(process.env.STREAM_RESOLVER_QUEUE_MAX) || 100));
const STREAM_RESOLVER_QUEUE_WAIT_MS = Math.max(5000, Math.min(120000,
  Number(process.env.STREAM_RESOLVER_QUEUE_WAIT_MS) || 45000));
const ytDlpQueue = createPrioritySerialQueue({ maxPending: STREAM_RESOLVER_QUEUE_MAX });
const STREAM_RESOLVER_FOREGROUND_PRIORITY = 10;
const STREAM_RESOLVER_BACKGROUND_PRIORITY = 0;

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
const streamPending = createClientPendingRegistry();
const backgroundPending = createClientPendingRegistry();
const BACKGROUND_PENDING_SCOPE = 'background';
const streamStats = { hits: 0, misses: 0, dedupes: 0, warmed: 0, fallbacks: 0, evictions: 0, previews: 0, retriesSuppressed: 0 };
const STREAM_RETRY_COOLDOWN_MS = Math.max(0, Math.min(60000,
  Number(process.env.STREAM_RETRY_COOLDOWN_MS) || 10000));
const streamRetryAt = new Map();
const streamFallback = require('./stream-fallback');
try {
  const saved = JSON.parse(fs.readFileSync(STREAM_CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) {
    if (v && v.expiresAt > Date.now() && isFullStream(v.data)) streamCache.set(k, v);
  }
} catch {}
let streamCacheDirty = false;
function pruneStreamCache(force) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of streamCache) {
    if (!v || !(v.expiresAt > now) || (v.data && !isFullStream(v.data))
      || (v.data && audioUrlExpiry(v.data.audio_url) <= now)) {
      streamCache.delete(k);
      changed = true;
    }
  }
  for (const [k, expiresAt] of streamRetryAt) {
    if (expiresAt <= now) streamRetryAt.delete(k);
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
const STREAM_RESOLVE_TIMEOUT_MS = Math.max(5000, Math.min(30000,
  Number(process.env.STREAM_RESOLVE_TIMEOUT_MS) || 12000));
const STREAM_SEARCH_TIMEOUT_MS = Math.max(2000, Math.min(10000,
  Number(process.env.STREAM_SEARCH_TIMEOUT_MS) || 6500));
const STREAM_RESOLVE_BUDGET_MS = Math.max(10000, Math.min(45000,
  Number(process.env.STREAM_RESOLVE_BUDGET_MS) || 26000));

function ytdlpOptions(timeoutMs) {
  return {
    timeout: Math.max(1000, timeoutMs),
    killSignal: 'SIGKILL',
  };
}

function ytdlpFlags(extra = {}) {
  return {
    noWarnings: true,
    ...(fs.existsSync('/var/lib/ytdlp/cookies.txt') ? { cookies: '/var/lib/ytdlp/cookies.txt' } : {}),
    ...extra,
  };
}

const backgroundYtDlpJobs = createBackgroundJobRegistry();
const foregroundYtDlpJobs = createClientJobRegistry();
function cancelBackgroundYtDlpJobs() {
  return backgroundYtDlpJobs.cancelAll();
}

function cancelledResolverError() {
  const error = new Error('Background stream resolution was cancelled');
  error.name = 'ResolverCancelledError';
  error.cancelled = true;
  return error;
}

/* youtube-dl-exec's convenience function hides the child handle. Use its exec
   method so an active background warm-up can be stopped immediately when the
   user selects a track. */
async function runYtDlp(url, flags, options, job) {
  if (job && job.cancelled) throw cancelledResolverError();
  const child = ytdlp.exec(url, flags, options);
  if (job) job.child = child;
  try {
    const result = await child;
    if (job && job.cancelled) throw cancelledResolverError();
    const stdout = String(result && result.stdout || '').trim();
    if (!stdout) return null;
    if (stdout.startsWith('{')) return JSON.parse(stdout);
    return stdout;
  } finally {
    if (job && job.child === child) job.child = null;
  }
}

async function runYtDlpExclusive(url, flags, options) {
  cancelBackgroundYtDlpJobs();
  return ytDlpQueue.run(
    () => runYtDlp(url, flags, options, null),
    STREAM_RESOLVER_FOREGROUND_PRIORITY,
    {
      waitTimeoutMs: STREAM_RESOLVER_QUEUE_WAIT_MS,
      maxPending: STREAM_RESOLVER_QUEUE_MAX,
    },
  );
}

function youtubeCandidates(entries) {
  return (entries || []).map((entry) => ({
    ...entry,
    name: entry.title || '',
    artist: entry.uploader || entry.uploaderName || entry.channel || '',
  }));
}

function classifyResolverFailure(error, job) {
  if (job.cancelled || error.cancelled || error.code === 'RESOLVER_JOB_CANCELLED') {
    return { cancelled: true, botBlocked: false, retry: false };
  }
  const botBlocked = isResolverBotChallenge(error);
  return {
    cancelled: false,
    botBlocked,
    retry: !botBlocked && isRetryableResolverError(error),
  };
}

async function resolveYoutubeStream(query, job = {}) {
  if (job.cancelled) return { cancelled: true };
  /* Search flat, select a genuinely matching video, then extract only that
     video. The old ytsearch3 path extracted three complete videos and was the
     main source of 50-140 second resolutions. */
  const deadline = Date.now() + STREAM_RESOLVE_BUDGET_MS;
  const searchQueries = ['ytsearch5:' + query, 'ytsearch5:' + query + ' audio'];
  const candidates = [];
  const seenVideoIds = new Set();
  let lastFailure = null;
  let botBlocked = false;

  for (const searchQuery of searchQueries) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastFailure = { stage: 'deadline', error: new Error('Stream resolution deadline exceeded') };
      break;
    }
    const searchTimeoutMs = Math.min(STREAM_SEARCH_TIMEOUT_MS, remaining);
    try {
      const result = await runYtDlp(searchQuery, ytdlpFlags({
        flatPlaylist: true,
        dumpSingleJson: true,
      }), ytdlpOptions(searchTimeoutMs), job);
      const entries = (result && result.entries) || [];
      for (const candidate of youtubeCandidates(entries)) {
        const score = trackMatchScore(candidate, query);
        if (score < 140 || !candidate.id || seenVideoIds.has(candidate.id)) continue;
        seenVideoIds.add(candidate.id);
        candidates.push({ candidate, score });
      }
      if (candidates.length) break;
      lastFailure = { stage: 'search', error: new Error('No matching YouTube result found') };
    } catch (error) {
      const action = classifyResolverFailure(error, job);
      if (action.cancelled) return { cancelled: true };
      lastFailure = { stage: 'search', error, timeoutMs: searchTimeoutMs };
      if (action.botBlocked) {
        botBlocked = true;
        break;
      }
      if (!action.retry) break;
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  for (let index = 0; index < Math.min(2, candidates.length); index++) {
    if (job.cancelled) return { cancelled: true };
    const candidate = candidates[index].candidate;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastFailure = { stage: 'deadline', error: new Error('Stream resolution deadline exceeded') };
      break;
    }
    const extractTimeoutMs = Math.min(STREAM_RESOLVE_TIMEOUT_MS, remaining);
    try {
      const videoUrl = candidate.url || 'https://www.youtube.com/watch?v=' + encodeURIComponent(candidate.id);
      const video = await runYtDlp(videoUrl, ytdlpFlags({
        dumpSingleJson: true,
      }), ytdlpOptions(extractTimeoutMs), job);
      const audioFormats = (video.formats || []).filter(
        (format) => format.acodec && format.acodec !== 'none'
          && (!format.vcodec || format.vcodec === 'none') && format.url
      );
      audioFormats.sort((left, right) => (right.abr || 0) - (left.abr || 0));
      const best = audioFormats[0];
      if (!best) {
        lastFailure = { stage: 'extract', error: new Error('No audio stream found') };
        continue;
      }
      return {
        stream: {
          title: video.title,
          duration: video.duration,
          audio_url: best.url,
          proxied_url: `/audio?u=${encodeURIComponent(best.url)}`,
          bitrate: best.abr,
          ext: best.ext,
          video_id: video.id,
          art: video.thumbnail || null,
          source: 'youtube',
          ...(index ? { retry: index } : {}),
        },
      };
    } catch (error) {
      const action = classifyResolverFailure(error, job);
      if (action.cancelled) return { cancelled: true };
      lastFailure = { stage: 'extract', error, timeoutMs: extractTimeoutMs };
      if (action.botBlocked) {
        botBlocked = true;
        break;
      }
      if (!action.retry) break;
    }
  }

  const failure = lastFailure || { stage: 'resolve', error: new Error('resolve failed') };
  const reason = `${failure.stage}: ${describeResolverError(failure.error, failure.timeoutMs)}`.slice(0, 240);
  return { error: reason, botBlocked };
}

async function resolveFreshStream(query, options = {}) {
  const job = createResolverJob(options);
  const foregroundRegistry = job.background ? null : foregroundYtDlpJobs.get(options.clientKey);
  if (typeof options.jobRef === 'object') options.jobRef.current = job;
  if (job.background) {
    backgroundYtDlpJobs.add(job);
  } else {
    if (options.supersede !== false) foregroundRegistry.cancelAll();
    foregroundRegistry.add(job);
  }
  let result;
  try {
    result = await ytDlpQueue.run(
      () => resolveYoutubeStream(query, job),
      options.background
        ? STREAM_RESOLVER_BACKGROUND_PRIORITY
        : STREAM_RESOLVER_FOREGROUND_PRIORITY,
      {
        signal: job.controller.signal,
        latestFirst: !options.background,
        waitTimeoutMs: options.background
          ? Math.min(STREAM_RESOLVER_QUEUE_WAIT_MS, 30000)
          : STREAM_RESOLVER_QUEUE_WAIT_MS,
        maxPending: STREAM_RESOLVER_QUEUE_MAX,
      },
    );
  } catch (error) {
    if (job.cancelled || error.cancelled || error.code === 'RESOLVER_JOB_CANCELLED') {
      return { cancelled: true };
    }
    result = { error: `resolver: ${describeResolverError(error)}`, botBlocked: false };
  } finally {
    if (job.background) backgroundYtDlpJobs.remove(job);
    else {
      foregroundRegistry.remove(job);
      foregroundYtDlpJobs.release(options.clientKey, foregroundRegistry);
    }
  }
  if (result.cancelled) return { cancelled: true };
  if (result.stream) return result.stream;

  const reason = result.error || 'resolve failed';
  console.error('Stream resolve failed after bounded attempts: ' + reason);

  /* Auto-healing: privacy frontends, then short previews, then peer rotation
     (triggered from noteBotFailure). A fallback result is cached like a normal hit. */
  try {
    const fallback = await streamFallback.resolve(query, reason);
    if (fallback && fallback.audio_url) {
      streamStats.fallbacks++;
      return { ...fallback, cache: 'fallback', fallbackReason: reason };
    }
  } catch (error) {
    console.error('Stream fallback failed: ' + (error && error.message || error));
  }
  alerts.record('stream-failure', 'critical', 'All stream sources failed for a track', { query, reason });
  return {
    error: result.botBlocked
      ? 'Stream unavailable — YouTube is blocking this track right now'
      : 'Stream unavailable right now',
    status: 502,
  };
}
function getStream(query, options = {}) {
  const key = streamKey(query);
  pruneStreamCache(false);
  const hit = streamCache.get(key);
  if (hit && isFullStream(hit.data) && hit.expiresAt > Date.now()
    && audioUrlExpiry(hit.data.audio_url) > Date.now()) {
    streamStats.hits++;
    return Promise.resolve({ ...hit.data, cache: 'hit' });
  }
  if (hit) { streamCache.delete(key); streamCacheDirty = true; }

  const preview = options.allowPreview === false ? null : previewFor(query);
  const pendingMap = options.background ? backgroundPending : streamPending;
  const pendingScope = options.background
    ? BACKGROUND_PENDING_SCOPE
    : String(options.clientKey || 'guest');
  const pending = pendingMap.get(key, pendingScope);
  if (pending) {
    streamStats.dedupes++;
    if (preview && !options.upgrade) {
      streamStats.previews++;
      return Promise.resolve({ ...preview, cache: 'preview' });
    }
    /* An upgrade request joins the existing foreground resolution instead of
       repeatedly polling its preview. The initial request still returned the
       preview immediately; this request resolves only when full media (or a
       terminal failure) is available. Pending work is isolated by browser
       session so one user's newer selection cannot cancel another user's
       request for the same track. */
    return pending;
  }

  /* A failed full-resolution attempt gets a short cooldown. Preview clients
     poll frequently; without this gate every poll would launch another yt-dlp
     child and keep the VPS saturated long after the first failure. */
  const retryAt = streamRetryAt.get(key) || 0;
  if (retryAt > Date.now()) {
    streamStats.retriesSuppressed++;
    if (preview) {
      return Promise.resolve({
        ...preview,
        cache: 'preview',
        retryAfterMs: retryAt - Date.now(),
      });
    }
    return Promise.resolve({
      error: 'Stream temporarily unavailable right now',
      status: 503,
      retryAfterMs: retryAt - Date.now(),
    });
  }
  if (retryAt) streamRetryAt.delete(key);

  /* A foreground click supersedes a queued warm-up for the same track. */
  if (!options.background) {
    const queuedAt = warmQueue.indexOf(key);
    if (queuedAt >= 0) warmQueue.splice(queuedAt, 1);
    if (options.cancelBackground !== false) cancelBackgroundYtDlpJobs();
  }

  const jobRef = {};
  const p = resolveFreshStream(query, {
    ...options,
    key,
    pendingMap,
    pendingScope,
    jobRef,
  }).then((data) => {
    if (data.cancelled) return data;
    if (data.error) {
      /* A failed hover/warm-up must never suppress the user's later click.
         Only foreground failures activate the shared retry cooldown. */
      if (!options.background) {
        const retryAt = Date.now() + STREAM_RETRY_COOLDOWN_MS;
        streamRetryAt.set(key, retryAt);
        return { ...data, retryAfterMs: Math.max(0, retryAt - Date.now()) };
      }
      return data;
    }
    streamStats.misses++;
    if (!isFullStream(data)) {
      let retryAfterMs = 0;
      if (data.fallbackReason && !options.background) {
        const retryAt = Date.now() + STREAM_RETRY_COOLDOWN_MS;
        streamRetryAt.set(key, retryAt);
        retryAfterMs = Math.max(0, retryAt - Date.now());
      }
      rememberPreview(query, data.audio_url, data.title, data.duration);
      return { ...data, cache: 'preview', ...(retryAfterMs ? { retryAfterMs } : {}) };
    }
    streamRetryAt.delete(key);
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
  }).catch((error) => {
    console.error('Stream resolver failed:', describeResolverError(error));
    let retryAfterMs = 0;
    if (!options.background) {
      const retryAt = Date.now() + STREAM_RETRY_COOLDOWN_MS;
      streamRetryAt.set(key, retryAt);
      retryAfterMs = Math.max(0, retryAt - Date.now());
    }
    return { error: 'Stream unavailable right now', status: 502, retryAfterMs };
  }).finally(() => {
    if (pendingMap.get(key, pendingScope) === p) {
      pendingMap.delete(key, pendingScope, p);
    }
  });
  if (jobRef.current) {
    jobRef.current.pendingMap = pendingMap;
    jobRef.current.pendingScope = pendingScope;
    jobRef.current.pendingPromise = p;
  }
  pendingMap.set(key, pendingScope, p);

  /* Provider previews start playback immediately while the complete stream is
     resolved and cached in the background for the next play. */
  if (preview && !options.upgrade) {
    streamStats.previews++;
    return Promise.resolve({ ...preview, cache: 'preview' });
  }

  /* A direct/library/radio selection may not have a preview in its URL. Look
     one up concurrently instead of making the listener wait for yt-dlp. The
     full-resolution promise remains pending and is used by the upgrade
     request; a preview never enters the full-stream cache. */
  if (!options.background && !options.upgrade) {
    const providerPreview = lookupProviderPreview(query).then((data) => (
      data ? { ...data, cache: 'preview' } : null
    ));
    return resolveFastestWithPreview(p, providerPreview).then((result) => {
      if (result.source === 'preview') streamStats.previews++;
      return result.data;
    });
  }
  return p;
}
const warmQueue = [];
let warming = false;
function warmStream(q) {
  const key = streamKey(q);
  const hit = streamCache.get(key);
  if (!key || (hit && isFullStream(hit.data) && hit.expiresAt > Date.now()
    && audioUrlExpiry(hit.data.audio_url) > Date.now()) || streamPending.has(key)
    || backgroundPending.has(key) || warmQueue.includes(key)) return;
  warmQueue.push(key);
  if (warmQueue.length > STREAM_WARM_MAX) warmQueue.shift();
  if (!warming) { warming = true; setImmediate(drainWarmQueue); }
}
async function drainWarmQueue() {
  try {
    while (warmQueue.length) {
      /* Background work never competes with a selected track. */
      if (streamPending.size) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const q = warmQueue.shift();
      try {
        const r = await getStream(q, { allowPreview: false, background: true });
        if (r && !r.error && !r.cancelled) streamStats.warmed++;
      } catch {}
    }
  } finally {
    warming = false;
    if (warmQueue.length && !warming) {
      warming = true;
      setImmediate(drainWarmQueue);
    }
  }
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
    backgroundPending: backgroundPending.size,
    queued: warmQueue.length,
    previewEntries: previewCache.size,
    max: STREAM_CACHE_MAX,
    hits: streamStats.hits,
    misses: streamStats.misses,
    dedupes: streamStats.dedupes,
    warmed: streamStats.warmed,
    previews: streamStats.previews,
    fallbacks: streamStats.fallbacks,
    evictions: streamStats.evictions,
    retriesSuppressed: streamStats.retriesSuppressed,
    retryCooldownMs: STREAM_RETRY_COOLDOWN_MS,
    resolverQueue: ytDlpQueue.pending,
    resolverRunning: ytDlpQueue.running,
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
let spToken = null, spTokenAt = 0, spTokenFailedAt = 0, spTokenPending = null;
async function getSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;
  if (spToken && Date.now() - spTokenAt < 3300 * 1000) return spToken;
  if (spTokenFailedAt && Date.now() - spTokenFailedAt < 30000) return null;
  if (spTokenPending) return spTokenPending;
  spTokenPending = (async () => {
    try {
      const r = await axios.post('https://accounts.spotify.com/api/token',
        new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        {
          auth: { username: process.env.SPOTIFY_CLIENT_ID, password: process.env.SPOTIFY_CLIENT_SECRET },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: Math.min(3000, PROVIDER_TIMEOUT_MS),
        });
      spToken = r.data.access_token; spTokenAt = Date.now(); spTokenFailedAt = 0;
      return spToken;
    } catch (e) {
      spTokenFailedAt = Date.now();
      console.error('Spotify token failed:', e.message);
      return null;
    } finally {
      spTokenPending = null;
    }
  })();
  return spTokenPending;
}

app.get('/stream', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ error: 'Missing ?q=' });

  const preview = String(req.query.preview || '').trim();
  if (preview) rememberPreview(query, preview, query, 30);

  try {
    const sessionCookie = String(req.headers.cookie || '').match(/(?:^|;\s*)wpsid=([^;]+)/i);
    const clientKey = sessionCookie
      ? `session:${crypto.createHash('sha256').update(sessionCookie[1]).digest('hex').slice(0, 24)}`
      : `guest:${String(req.ip || 'unknown')}`;
    const upgrade = req.query.upgrade === '1';
    const data = await getStream(query, {
      clientKey,
      upgrade,
      supersede: !upgrade,
      cancelBackground: true,
    });
    if (data.cancelled) {
      res.set('Retry-After', '1');
      return res.status(409).json({
        error: 'Stream resolution was superseded',
        retryAfterMs: 1000,
      });
    }
    if (data.error) {
      const retryAfterMs = Math.max(0, Number(data.retryAfterMs) || 0);
      if (retryAfterMs > 0) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        return res.status(data.status || 503).json({ error: data.error, retryAfterMs });
      }
      return res.status(data.status || 502).json({ error: data.error });
    }
    res.set('X-WP-Stream-Cache', data.cache || 'miss');
    res.set('X-WP-Stream-Source', data.source || 'youtube');
    res.json(data);
  } catch (error) {
    console.error('Stream Error:', error && error.message || error);
    res.status(502).json({ error: 'Could not get audio stream' });
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
    const info = await runYtDlpExclusive(
      url,
      ytdlpFlags({ dumpSingleJson: true }),
      ytdlpOptions(20000),
    );
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
        stream_url: makeStreamUrl(name + ' ' + artist, t.audioPreview?.url || null),
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
  const name = t.name || '';
  const artists = (t.artists || []).map((a) => a.name).filter(Boolean);
  const artist = artists.join(', ');
  const query = streamQueryFor(name, artists[0] || artist);
  const preview = t.preview_url || null;
  rememberPreview(query, preview, name, 30);
  return {
    id: 'sp-' + t.id,
    name,
    artist,
    album: t.album?.name || '',
    art: t.album?.images?.[0]?.url || null,
    duration_ms: t.duration_ms || 0,
    genre: null,
    preview_url: preview,
    stream_url: makeStreamUrl(query, preview),
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
    if (p.endsWith('.html') || f.startsWith('enhance.') || f.startsWith('account-chip.')
      || f.startsWith('notification-policy.')) {
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
