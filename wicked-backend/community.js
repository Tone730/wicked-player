/* Community module: profiles, friends, chat, presence, listen-together */
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');

const COMM_FILE = path.join(__dirname, 'data', 'community.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(COMM_FILE, 'utf8'));
  } catch {
    return { profiles: {}, chat: { general: [] } };
  }
}
function save(d) {
  fs.mkdirSync(path.dirname(COMM_FILE), { recursive: true });
  fs.writeFileSync(COMM_FILE, JSON.stringify(d, null, 2));
}

function dmKey(a, b) {
  return 'dm:' + [a, b].sort().join('|');
}
function pushChat(d, conv, msg) {
  d.chat[conv] = d.chat[conv] || [];
  d.chat[conv].push(msg);
  if (d.chat[conv].length > 200) d.chat[conv] = d.chat[conv].slice(-200);
  save(d);
}

/* ---------- REST: profiles + upload listing helpers ---------- */
const router = express.Router();

router.get('/api/profiles', (req, res) => {
  const d = load();
  const out = {};
  for (const [name, p] of Object.entries(d.profiles)) {
    const { discordWebhook: _w, ...safe } = p;
    out[name] = {
      bio: safe.bio ?? '',
      accent: safe.accent ?? '#8b5cf6',
      avatar: safe.avatar ?? null,
      banner: safe.banner ?? null,
      displayName: safe.displayName ?? '',
      status: safe.status ?? '',
      favGenre: safe.favGenre ?? '',
      links: safe.links ?? {},
      bannerStyle: safe.bannerStyle ?? '',
      bannerFrom: safe.bannerFrom ?? '',
      bannerTo: safe.bannerTo ?? '',
      bannerAnimated: !!safe.bannerAnimated,
      tagText: safe.tagText ?? '',
      tagColor: safe.tagColor ?? '',
      tagGlow: !!safe.tagGlow,
      tagAnim: safe.tagAnim ?? '',
      friends: safe.friends ?? [],
      incoming: safe.requests || [],
      premium: !!safe.premium,
    };
  }
  res.json(out);
});

const LINK_KEYS = ['discord', 'tiktok', 'instagram', 'twitter', 'youtube', 'spotify', 'twitch', 'soundcloud', 'website'];

router.post('/api/profile', (req, res) => {
  const d = load();
  const { name, bio, accent, avatar, banner, displayName, status, favGenre, links, discordWebhook } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (isBanned(name)) return res.status(403).json({ error: 'This account is banned' });
  d.profiles[name] = d.profiles[name] || { friends: [], requests: [] };
  const p = d.profiles[name];
  /* token gate: once a profile has a password, edits need its token */
  const toks = p.authTokens || (p.authToken ? [p.authToken] : []);
  if (p.passHash && toks.length && !toks.includes(req.get('X-WP-AUTH'))) {
    return res.status(401).json({ error: 'Not signed in as this profile - sign in with your password' });
  }
  if (bio !== undefined) p.bio = String(bio).slice(0, 200);
  if (accent !== undefined) p.accent = String(accent).slice(0, 20);
  if (avatar !== undefined) p.avatar = avatar;
  if (banner !== undefined) p.banner = banner;
  if (displayName !== undefined) p.displayName = String(displayName).slice(0, 40);
  if (status !== undefined) p.status = String(status).slice(0, 80);
  if (favGenre !== undefined) p.favGenre = String(favGenre).slice(0, 40);
  /* profile cosmetics - premium features enforced server-side */
  const premiumNow = !!p.premium;
  if (req.body.bannerStyle !== undefined) p.bannerStyle = String(req.body.bannerStyle).slice(0, 24);
  if (req.body.bannerFrom !== undefined) p.bannerFrom = String(req.body.bannerFrom).slice(0, 20);
  if (req.body.bannerTo !== undefined) p.bannerTo = String(req.body.bannerTo).slice(0, 20);
  if (req.body.bannerAnimated !== undefined) p.bannerAnimated = premiumNow ? !!req.body.bannerAnimated : false;
  if (req.body.tagText !== undefined) p.tagText = premiumNow ? String(req.body.tagText).slice(0, 24) : (p.tagText || '');
  if (req.body.tagColor !== undefined) p.tagColor = premiumNow ? String(req.body.tagColor).slice(0, 20) : (p.tagColor || '');
  if (req.body.tagGlow !== undefined) p.tagGlow = premiumNow ? !!req.body.tagGlow : false;
  if (req.body.tagAnim !== undefined) p.tagAnim = premiumNow ? String(req.body.tagAnim).slice(0, 20) : (p.tagAnim || '');
  if (links !== undefined && typeof links === 'object' && links !== null) {
    const clean = {};
    for (const k of LINK_KEYS) {
      if (typeof links[k] === 'string' && links[k].trim()) {
        let v = links[k].trim().slice(0, 120);
        if (k === 'discord' && /^\d{17,20}$/.test(v)) v = 'discord.gg/' + v; // raw id support
        clean[k] = v;
      }
    }
    p.links = clean;
  }
  /* premium is NEVER settable here — admin-only via key or codes */
  if (discordWebhook !== undefined) p.discordWebhook = String(discordWebhook || '');
  save(d);
  res.json({ ok: true });
});

router.post('/discord/say', async (req, res) => {
  const d = load();
  const { name, track, message } = req.body;
  const me = d.profiles[name];
  if (!me?.discordWebhook) return res.status(400).json({ error: 'No Discord webhook connected' });
  try {
    await axios.post(me.discordWebhook, {
      username: `${name} · Wicked Player`,
      embeds: [{
        title: track?.name || message || 'Now playing',
        description: track ? `by ${track.artist}` : undefined,
        thumbnail: track?.art ? { url: track.art } : undefined,
        footer: { text: 'Wicked Player · listening free' },
        color: 0x8b5cf6,
      }],
    }, { timeout: 10000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Discord webhook failed: ' + e.message });
  }
});


/* ============================================================
   ADMIN: user management, bans, security log (admin-key only)
============================================================ */
const ADMIN_KEY_COMM = process.env.ADMIN_KEY || '72e9a3f1-5c08-4b6c-8e6b-7f2f60e0eda3';
const adminAuthComm = (req, res, next) => { if (req.get('X-ADMIN-KEY') !== ADMIN_KEY_COMM) return res.status(401).json({ msg: 'no' }); next(); };
const BANS_FILE = path.join(__dirname, 'data', 'bans.json');
const SEC_FILE = path.join(__dirname, 'data', 'security.json');
function readBans() { try { return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')); } catch { return {}; } }
function writeBans(b) { fs.mkdirSync(path.dirname(BANS_FILE), { recursive: true }); fs.writeFileSync(BANS_FILE, JSON.stringify(b, null, 2)); }
function secLog(event, actor, detail) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')); } catch {}
  log.push({ at: Date.now(), event, actor: actor || '-', detail: detail || '' });
  if (log.length > 300) log = log.slice(-300);
  fs.mkdirSync(path.dirname(SEC_FILE), { recursive: true });
  fs.writeFileSync(SEC_FILE, JSON.stringify(log, null, 2));
}
function isBanned(name) { const b = readBans(); return !!b[name]; }

router.get('/api/admin/users', adminAuthComm, (req, res) => {
  const d = load();
  const bans = readBans();
  const out = Object.entries(d.profiles).map(([name, p]) => ({
    name,
    premium: !!p.premium,
    banned: !!bans[name],
    banReason: bans[name]?.reason || '',
    lastSeen: p.lastSeen || 0,
    status: p.status || '',
    tagText: p.tagText || '',
  }));
  res.json(out);
});
router.post('/api/admin/premium', adminAuthComm, (req, res) => {
  const d = load();
  const { name, on } = req.body;
  if (!name || !d.profiles[name]) return res.status(404).json({ error: 'unknown user' });
  d.profiles[name].premium = !!on;
  save(d);
  secLog('premium', 'admin', name + ' -> ' + (!!on ? 'GRANTED' : 'REVOKED'));
  res.json({ ok: true, name, premium: !!on });
});
router.post('/api/admin/ban', adminAuthComm, (req, res) => {
  const { name, reason } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (isBanned(name)) return res.status(403).json({ error: 'This account is banned' });
  const bans = readBans();
  bans[name] = { reason: String(reason || 'no reason given').slice(0, 140), at: Date.now() };
  writeBans(bans);
  secLog('ban', 'admin', name + ' (' + bans[name].reason + ')');
  res.json({ ok: true, name, banned: true });
});
router.post('/api/admin/unban', adminAuthComm, (req, res) => {
  const { name } = req.body;
  const bans = readBans();
  delete bans[name];
  writeBans(bans);
  secLog('unban', 'admin', name);
  res.json({ ok: true, name, banned: false });
});
router.get('/api/admin/security', adminAuthComm, (req, res) => {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')); } catch {}
  res.json(log.sort((a, b) => b.at - a.at).slice(0, 100));
});

/* ============================================================
   AUTH: password-protected profiles (so saves are really yours)
============================================================ */
const crypto = require('crypto');
function hashPass(name, pass) {
  return crypto.createHash('sha256').update('wp:' + name + ':' + pass).digest('hex');
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

router.post('/api/auth', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });
  const d = load();
  const p = d.profiles[name] = d.profiles[name] || { friends: [], requests: [] };
  if (isBanned(name)) return res.status(403).json({ error: 'This account is banned' });
  if (p.passHash) {
    if (hashPass(name, password) !== p.passHash) return res.status(401).json({ error: 'Wrong password for this name' });
  } else {
    p.passHash = hashPass(name, password); /* first claim of this name */
  }
  p.authTokens = p.authTokens || [];
  p.authTokens.push(newToken());
  if (p.authTokens.length > 5) p.authTokens = p.authTokens.slice(-5);
  p.lastSeen = Date.now();
  save(d);
  res.json({ ok: true, token: p.authToken, name, premium: !!p.premium });
});
/* ---------- Socket layer ---------- */
function attach(io) {
  const d = load();
  const online = new Map(); // socket.id -> profile snapshot
  const rooms = new Map();  // room -> { host, members:Set<sid>, track, playing, epoch, position }

  const me = (s) => online.get(s.id);
  const snapshot = () => [...online.entries()].map(([sid, p]) => ({ sid, ...p }));

  io.on('connection', (socket) => {
    socket.join('general');

    socket.on('hello', (profile) => {
      if (!profile?.name) return;
      if (isBanned(profile.name)) {
        const reason = readBans()[profile.name]?.reason || '';
        socket.emit('banned', { reason });
        socket.disconnect(true);
        return;
      }
      const saved = d.profiles[profile.name] || {};
      const p = {
        sid: socket.id,
        name: profile.name,
        bio: profile.bio ?? saved.bio ?? '',
        accent: profile.accent ?? saved.accent ?? '#8b5cf6',
        avatar: profile.avatar ?? saved.avatar ?? null,
        banner: profile.banner ?? saved.banner ?? null,
        premium: !!(profile.premium ?? saved.premium),
        nowplaying: null,
      };
      p.lastSeen = Date.now();
      d.profiles[p.name] = d.profiles[p.name] || { friends: [], requests: [] };
      d.profiles[p.name].lastSeen = p.lastSeen;
      save(d);
      online.set(socket.id, p);
      io.emit('community', snapshot());
      socket.emit('rooms', { chat: ['general', ...Object.keys(d.chatRooms || {}).map((n) => '#' + n)], listen: [...rooms.values()].filter(r => r.members.size || true).map(r => ({
        name: r.name, host: r.host,
        listeners: [...io.sockets.adapter.rooms.get(r.name) || []].length,
        track: r.track ? { id: r.track.id, name: r.track.name, artist: r.track.artist, art: r.track.art, stream_url: r.track.stream_url, duration_ms: r.track.duration_ms } : null,
        playing: r.playing, epoch: r.epoch, position: r.position,
      })) });
    });

    /* ---- group chat rooms + invites ---- */
    socket.on('room:create', ({ name }, cb) => {
      const p = me(socket);
      if (!p || !name) return;
      const clean = String(name).replace(/^#+/, '').trim().slice(0, 32);
      if (!clean) return;
      const key = '#' + clean;
      d.chatRooms = d.chatRooms || {};
      if (!d.chatRooms[clean]) {
        d.chatRooms[clean] = { owner: p.name, invite: Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''), at: Date.now() };
        save(d);
      }
      const meta = d.chatRooms[clean];
      cb?.({ room: key, invite: meta.invite, owner: meta.owner });
      io.emit('rooms', { chat: ['general', ...Object.keys(d.chatRooms).map((n) => '#' + n)], listen: [] });
    });

    socket.on('room:join', ({ code }, cb) => {
      d.chatRooms = d.chatRooms || {};
      const entry = Object.entries(d.chatRooms).find(([, r]) => r.invite === String(code || '').toUpperCase().trim());
      if (!entry) return cb?.({ error: 'Invalid invite code' });
      cb?.({ room: '#' + entry[0], name: entry[0], owner: entry[1].owner });
    });

    socket.on('room:info', ({ room }, cb) => {
      d.chatRooms = d.chatRooms || {};
      const clean = String(room || '').replace(/^#+/, '');
      const meta = d.chatRooms[clean];
      cb?.({ name: clean, owner: meta?.owner || null, invite: meta?.invite || null });
    });

    socket.on('profile:update', (patch) => {
      const p = me(socket);
      if (!p || !patch) return;
      Object.assign(p, patch);
      if (patch.bio !== undefined || patch.accent !== undefined || patch.avatar !== undefined || patch.banner !== undefined || patch.premium !== undefined) {
        d.profiles[p.name] = d.profiles[p.name] || { friends: [], requests: [] };
        const s = d.profiles[p.name];
        if (patch.bio !== undefined) s.bio = patch.bio;
        if (patch.accent !== undefined) s.accent = patch.accent;
        if (patch.avatar !== undefined) s.avatar = patch.avatar;
        if (patch.banner !== undefined) s.banner = patch.banner;
        if (patch.premium !== undefined) s.premium = !!patch.premium;
        save(d);
      }
      io.emit('community', snapshot());
    });

    socket.on('np', ({ track }) => {
      const p = me(socket);
      if (!p) return;
      p.nowplaying = track ? { id: track.id, name: track.name, artist: track.artist, art: track.art, stream_url: track.stream_url, duration_ms: track.duration_ms, accent: p.accent } : null;
      io.emit('community', snapshot());
    });

    socket.on('disconnect', () => {
      const p = me(socket);
      if (p) {
        // close any rooms they hosted
        for (const [rn, r] of [...rooms]) {
          r.members?.delete(socket.id);
          if (r.host === p.name && r.members.size === 0) rooms.delete(rn);
        }
      }
      online.delete(socket.id);
      io.emit('community', snapshot());
    });

    /* chat */
    socket.on('chat', ({ to, room, text }) => {
      const p = me(socket);
      if (!p || !text) return;
      const conv = to ? dmKey(p.name, to) : (room || 'general');
      const msg = { from: p.name, text: String(text).slice(0, 500), at: Date.now(), avatar: p.avatar, accent: p.accent };
      pushChat(load(), conv, msg);
      /* !sr songrequest - queue a song for everyone */
      const srMatch = text.match(/^!(?:sr|songrequest)\s+(.+)/i);
      if (srMatch) {
        const q = srMatch[1].trim().slice(0, 120);
        axios.get('https://api.deezer.com/search', { params: { q, limit: 1 }, timeout: 8000 })
          .then((r) => {
            const t = (r.data.data || [])[0];
            if (!t) return;
            const track = {
              id: 'dz-' + t.id, name: t.title_short || t.title, artist: t.artist?.name || '',
              album: t.album?.title || '', art: t.album?.cover_big || t.album?.cover_medium || null,
              duration_ms: (t.duration || 0) * 1000,
              stream_url: '/stream?q=' + encodeURIComponent((t.title_short || t.title) + ' ' + (t.artist?.name || '')),
              src: 'deezer',
            };
            io.emit('sr:new', { from: p.name, track });
          }).catch(() => {});
      }
      if (to) {
        for (const [sid, q] of online) {
          if (q.name === to || q.name === p.name) io.to(sid).emit('chat:new', { conv, msg });
        }
      } else {
        io.emit('chat:new', { conv, msg });
      }
    });

    /* queue a track for everyone in a listen room */
    socket.on('sr:room', ({ room, track }) => {
      const p2 = me(socket);
      if (!p2 || !room || !track) return;
      io.to(room).emit('sr:new', { from: p2.name, track });
    });

    socket.on('chat:get', ({ conv }, cb) => {
      const dd = load();
      cb?.({ conv, messages: dd.chat[conv] || [] });
    });

    /* friends */
    socket.on('friend:ask', ({ name }) => {
      const p = me(socket);
      if (!p || !name || name === p.name) return;
      const dd = load();
      const target = dd.profiles[name] = dd.profiles[name] || { friends: [], requests: [] };
      const mine = dd.profiles[p.name] = dd.profiles[p.name] || { friends: [], requests: [] };
      if ((target.friends || []).includes(p.name)) return;
      target.requests = target.requests || [];
      if (!target.requests.includes(p.name)) target.requests.push(p.name);
      mine.requests = mine.requests || [];
      if (!mine.requests.includes(name)) mine.requests.push(name);
      save(dd);
      for (const [sid, q] of online) if (q.name === name) io.to(sid).emit('friend:incoming', { from: p.name });
    });

    socket.on('friend:accept', ({ name }) => {
      const p = me(socket);
      if (!p) return;
      const dd = load();
      const mine = dd.profiles[p.name] = dd.profiles[p.name] || { friends: [], requests: [] };
      mine.friends = mine.friends || [];
      mine.requests = (mine.requests || []).filter((x) => x !== name);
      const theirs = dd.profiles[name] = dd.profiles[name] || { friends: [], requests: [] };
      theirs.friends = theirs.friends || [];
      theirs.requests = (theirs.requests || []).filter((x) => x !== 'me?');
      if (!theirs.friends.includes(p.name)) theirs.friends.push(p.name);
      if (!mine.friends.includes(name)) mine.friends.push(name);
      save(dd);
      io.emit('community', snapshot());
    });

    socket.on('friend:decline', ({ name }) => {
      const p = me(socket);
      if (!p) return;
      const dd = load();
      const mine = dd.profiles[p.name];
      if (mine) {
        mine.requests = (mine.requests || []).filter((x) => x !== name);
        save(dd);
      }
    });

    /* listen together */
    socket.on('listen:create', ({ room }, cb) => {
      const p = me(socket);
      if (!p || !room) return;
      rooms.set(room, { name: room, host: p.name, members: new Set([socket.id]), track: null, playing: false, epoch: 0, position: 0 });
      socket.join(room);
      cb?.({ ok: true });
    });

    socket.on('listen:join', ({ room }) => {
      const p = me(socket);
      const r = rooms.get(room);
      if (!p || !r) return;
      socket.join(room);
      r.members?.add(socket.id);
      if (r.track && r.playing) {
        socket.emit('listen', { room, track: r.track, playing: true, epoch: r.epoch, position: (Date.now() - r.epoch) / 1000 });
      }
    });

    socket.on('listen:set', ({ room, track, playing, position }) => {
      const p = me(socket);
      const r = rooms.get(room);
      if (!p || !r || r.host !== p.name) return;
      r.track = track || r.track;
      if (position !== undefined) r.position = position;
      r.playing = !!playing;
      r.epoch = playing ? Date.now() - (r.position || 0) * 1000 : r.epoch;
      r.members.delete(socket.id);
      io.to(room).emit('listen', { room, track: r.track, playing: r.playing, epoch: r.epoch, position: r.position });
      r.members.add(socket.id);
    });

    socket.on('listen:leave', ({ room }) => {
      const p = me(socket);
      const r = rooms.get(room);
      if (!p || !r) return;
      socket.leave(room);
      r.members?.delete(socket.id);
      if (r.host === p.name && r.members.size === 0) rooms.delete(room);
    });

    socket.on('listen:state', (room, cb) => {
      const r = rooms.get(room);
      if (!r) return cb?.(null);
      const position = r.playing ? (Date.now() - r.epoch) / 1000 : (r.position || 0);
      cb?.({ room, track: r.track, playing: r.playing, epoch: r.epoch, position });
    });
  });

  return { router, load, save, onlineSnapshot: snapshot };
}

module.exports = { router, attach, load, save };
