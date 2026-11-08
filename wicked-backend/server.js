require('dotenv').config();
const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
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
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 40e6 });
app.use(community.router);
community.attach(io);

/* media files (uploaded mp3/mp4/gif images) */
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR));

/* Upload a file (image/gif/mp3/mp4) as base64 data URL */
const MIME_EXT = {
  'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/mp4': 'm4a',
  'audio/wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm',
};
app.post('/upload', (req, res) => {
  const { name, data } = req.body;
  const m = String(data || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'missing data' });
  const ext = MIME_EXT[m[1]] || 'bin';
  const file = `${Date.now()}-${String(name || 'file').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40)}${ext === path.extname(String(name || '')) ? '' : path.extname(String(name || ''))}`.replace(/\.bin$/, '.' + ext);
  fs.writeFile(path.join(MEDIA_DIR, file), Buffer.from(m[2], 'base64'), (err) => {
    if (err) return res.status(500).json({ error: 'save failed' });
    const kind = (m[1] || '').includes('audio') ? 'audio' : 'video';
    const track = kind === 'audio'
      ? { id: 'file-' + file, name: (name || file).replace(/\.[^.]+$/, ''), artist: 'Local file', album: 'Your files', art: null, duration_ms: 0, stream_url: `/media/${file}`, local: true }
      : { id: 'file-' + file, name: (name || file), artist: 'Local file', album: 'Your files', art: null, duration_ms: 0, stream_url: `/media/${file}`, local: true, video: kind !== 'audio' };
    const what = kind === 'audio' ? 'track' : 'video';
    track.kind = what;
    res.json({ file, url: `/media/${file}`, track });
  });
});

/* ============================================================
   PLAYLISTS (persisted in library.json)
============================================================ */
const PLAYLISTS_FILE = path.join(__dirname, 'data', 'playlists.json');

app.get('/library/playlists', (req, res) => {
  const user = String(req.query.user || '');
  try {
    let list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
    if (user) list = list.filter((pl) => !pl.user || pl.user === user);
    res.json(list);
  } catch { res.json([]); }
});

app.post('/library/playlists', (req, res) => {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch {}
  const { name, tracks, user, public: isPublic } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'missing name' });
  let pl = list.find((p) => p.name === name && (!user || !p.user || p.user === user));
  if (!pl) {
    pl = { name, user: user || undefined, tracks: [], created: Date.now() };
    list.push(pl);
  }
  if (isPublic !== undefined) pl.public = !!isPublic;
  if (tracks?.length) {
    for (const t of tracks) if (!pl.tracks.find((x) => x.id === t.id)) pl.tracks.push(t);
  }
  fs.mkdirSync(path.dirname(PLAYLISTS_FILE), { recursive: true });
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(list, null, 2));
  res.json(list);
});

app.delete('/library/playlists/:name', (req, res) => {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch {}
  const user = String(req.query.user || '');
  list = list.filter((p) => !(p.name === req.params.name && (!user || !p.user || p.user === user)));
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(list, null, 2));
  res.json(list);
});


/* ============================================================
   PLAYLIST VISIBILITY (public/private) + discovery feed
============================================================ */
app.post('/library/playlists/visibility', (req, res) => {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch {}
  const { user, name, isPublic } = req.body;
  const pl = list.find((p) => p.name === name && p.user === user);
  if (!pl) return res.status(404).json({ error: 'playlist not found' });
  pl.public = !!isPublic;
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(list, null, 2));
  res.json({ ok: true, name: pl.name, public: !!pl.public });
});
app.get('/library/playlists/public', (req, res) => {
  try {
    const list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
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
  fs.writeFileSync(LIB_FILE, JSON.stringify(lib, null, 2));
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
    const info = await ytdlp(url, { dumpSingleJson: true, noWarnings: true });
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIB_FILE, JSON.stringify(lib, null, 2));
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
const STATS_FILE = './data/listen-stats.json';
function readStats() { try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return {}; } }
app.post('/api/stats/listen', (req, res) => {
  const user = String(req.body.user || 'guest').slice(0, 40);
  const secs = Math.max(0, Math.min(3600, Number(req.body.secs) || 60));
  const st = readStats();
  const u = st[user] = st[user] || { total: 0, months: {} };
  const month = new Date().toISOString().slice(0, 7);
  u.total += secs;
  u.months[month] = (u.months[month] || 0) + secs;
  fs.writeFileSync(STATS_FILE, JSON.stringify(st, null, 2));
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
const ADMIN_KEY = process.env.ADMIN_KEY || '72e9a3f1-5c08-4b6c-8e6b-7f2f60e0eda3';
const adminAuth = (req, res, next) => { if (req.get('X-ADMIN-KEY') !== ADMIN_KEY) return res.status(401).json({ msg: 'no' }); next(); };
const codesFile = './data/codes.json';
function jsonRead(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function jsonWrite(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
/* ============================================================
   REWARDS: random drops for listening time - claim via Discord
============================================================ */
const rewardsFile = './data/rewards.json';
async function readRewards() {
  try { return JSON.parse(await fs.promises.readFile(rewardsFile, 'utf8')); } catch { return { issued: [] }; }
}
async function writeRewards(d) { await fs.promises.writeFile(rewardsFile, JSON.stringify(d, null, 2)); }
const REWARD_TYPES = [
  { type: 'badge',    label: 'Loyalty badge - show it off on your profile', weight: 30 },
  { type: 'bonus',    label: 'Bonus soundboard pack (this week only)',      weight: 24 },
  { type: 'shoutout', label: 'Discord shoutout from the host',              weight: 20 },
  { type: 'skip',     label: '3 unlimited-skip boosters',                   weight: 14 },
  { type: 'premium',  label: 'FREE Premium code - redeem in Settings',      weight: 8  },
  { type: 'jackpot',  label: 'JACKPOT - 7-day Premium code',                weight: 4  },
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
  const user = String(req.body.user || 'guest').slice(0, 40);
  const now = Date.now();
  const d = await readRewards();
  const mine = d.issued.filter((r) => r.user === user);
  const last = mine.sort((a, b) => b.at - a.at)[0];
  const lastWait = last?.waitMs || 10 * 60 * 1000;
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
  rw.nextWaitMs = 8 * 60 * 1000 + Math.floor(Math.random() * 17 * 60 * 1000);
  await writeRewards(d);
  res.json(rw);
});
app.get('/api/rewards', async (req, res) => {
  const user = String(req.query.user || '').slice(0, 40);
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
    fs.writeFileSync(ERR_FILE, JSON.stringify(log, null, 2));
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
    const searchResults = await ytdlp('ytsearch1:' + query + ' audio', {
      dumpSingleJson: true,
      noWarnings: true,
    });
    const video = searchResults.entries[0];
    if (!video) return res.status(404).json({ error: 'No YouTube result found' });

    const audioFormats = (video.formats || []).filter(
      (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const best = audioFormats[0];
    if (!best || !best.url) return res.status(404).json({ error: 'No audio stream found' });

    res.json({
      title: video.title,
      duration: video.duration,
      audio_url: best.url,
      proxied_url: `/audio?u=${encodeURIComponent(best.url)}`, // same-origin -> enables Web Audio EQ
      bitrate: best.abr,
      ext: best.ext,
      video_id: video.id,
    });
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
    const info = await ytdlp(url, { dumpSingleJson: true, noWarnings: true });
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

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (!skipRange && req.headers.range) headers.Range = req.headers.range;
    const upstream = await axios.get(u, { headers, responseType: 'stream', timeout: 20000 });
    const h = upstream.headers;
    if (h['content-type']) res.setHeader('Content-Type', h['content-type']);
    if (h['content-length']) res.setHeader('Content-Length', h['content-length']);
    if (h['content-range']) res.setHeader('Content-Range', h['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.status(h['content-range'] ? 206 : 200);
    upstream.data.pipe(res);
    // clean up on client disconnect
    res.on('close', () => upstream.data.destroy());
  } catch (error) {
    console.error('Audio Proxy Error:', error.message);
    if (!res.headersSent) res.status(502).json({ error: 'Audio proxy failed' });
    else res.end();
  }
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
