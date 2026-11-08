/* ============================================================
   WICKED PLAYER — AUTH & ADMIN SYSTEM
   Accounts (scrypt-hashed passwords), cookie sessions,
   bans/timeouts, roles, Discord OAuth linking/login,
   admin API + gated app access.
   Zero external dependencies (node:crypto only).
============================================================ */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/* ---------------- stores ---------------- */
let users = {};     // username -> account
let sessions = {};  // token -> { user, created, lastSeen, ip, ua }
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}

let saveTimerU = null, saveTimerS = null;
function saveUsers() { clearTimeout(saveTimerU); saveTimerU = setTimeout(() => {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
}, 200); }
function saveSessions() { clearTimeout(saveTimerS); saveTimerS = setTimeout(() => {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch {}
}, 200); }

/* ---------------- password hashing (scrypt) ---------------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 64);
    return crypto.timingSafeEqual(Buffer.from(test.toString('hex')), Buffer.from(hash));
  } catch { return false; }
}

/* ---------------- session helpers ---------------- */
const COOKIE = 'wpsid';
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(username, req) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    user: username,
    created: Date.now(),
    lastSeen: Date.now(),
    ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().slice(0, 60),
    ua: (req.headers['user-agent'] || '').toString().slice(0, 120),
  };
  // keep sessions file bounded
  const keys = Object.keys(sessions);
  if (keys.length > 500) {
    keys.sort((a, b) => sessions[a].lastSeen - sessions[b].lastSeen);
    for (let i = 0; i < keys.length - 400; i++) delete sessions[keys[i]];
  }
  saveSessions();
  return token;
}
function userFromReq(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return null;
  const s = sessions[tok];
  if (!s) return null;
  s.lastSeen = Date.now();
  const u = users[s.user];
  if (!u) { delete sessions[tok]; saveSessions(); return null; }
  return { token: tok, session: s, account: u, username: s.user };
}
function isBannedNow(u) {
  if (!u) return null;
  if (u.banned) {
    if (!u.bannedUntil) return { permanent: true, reason: u.banReason || 'Banned' };
    if (Date.now() < u.bannedUntil) {
      return { permanent: false, until: u.bannedUntil, reason: u.banReason || 'Timed out' };
    }
    // timeout expired
    u.banned = false; u.bannedUntil = null; saveUsers();
  }
  return null;
}

/* ---------------- admin bootstrap ---------------- */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'wicked-admin';
if (!users[ADMIN_USER]) {
  const { salt, hash } = hashPassword(ADMIN_PASS);
  users[ADMIN_USER] = { passHash: hash, salt, role: 'admin', createdAt: Date.now(), banned: false };
  saveUsers();
  console.log(`[auth] admin account created -> ${ADMIN_USER} / ${ADMIN_PASS} (change via admin panel)`);
}

/* ---------------- discord oauth (optional, configured via .env) ---------------- */
const DISCORD = {
  get configured() {
    return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
  },
  authorizeUrl(req, state) {
    const redirect = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
    const p = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'identify',
      state,
    });
    return 'https://discord.com/oauth2/authorize?' + p.toString();
  },
  async exchange(code, req) {
    const redirect = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
    const body = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
    });
    const r = await axios.post('https://discord.com/api/oauth2/token', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000,
    });
    const me = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${r.data.access_token}` }, timeout: 10000,
    });
    return me.data; // { id, username, global_name, avatar }
  },
  avatarUrl(d) {
    if (!d) return null;
    if (d.avatar) return `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png?size=128`;
    const idx = (BigInt(d.id || 0) >> BigInt(22)) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  },
};

/* ---------------- pending oauth states ---------------- */
const oauthStates = new Set();

/* ---------------- html helpers ---------------- */
function serveFile(res, name, status = 200) {
  const p = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(p)) { res.status(500).send('missing page: ' + name); return; }
  res.setHeader('Cache-Control', 'no-cache');
  res.status(status).sendFile(p);
}
function injectUser(html, user) {
  if (!user) return html;
  const info = JSON.stringify({
    username: user.username,
    role: user.account.role,
    discord: user.account.discord || null,
  });
  return html.replace('</head>', `<script>window.__WP_USER=${info};</script>\n</head>`);
}

/* ============================================================
   PUBLIC ROUTES
============================================================ */
const router = express.Router();

router.get('/auth/me', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.json({ user: null });
  const ban = isBannedNow(u.account);
  if (ban) return res.json({ user: null, banned: ban });
  const a = u.account;
  res.json({ user: { username: u.username, role: a.role, discord: a.discord || null, createdAt: a.createdAt } });
});

router.post('/auth/register', (req, res) => {
  if (String(process.env.ALLOW_REGISTRATION ?? '1') !== '1') {
    return res.status(403).json({ error: 'Registration is disabled. Ask the admin for an account.' });
  }
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_\-\.]{2,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 2-20 chars, letters/numbers/_ - .' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (users[username]) return res.status(409).json({ error: 'That username is taken' });
  const { salt, hash } = hashPassword(password);
  users[username] = { passHash: hash, salt, role: 'user', createdAt: Date.now(), banned: false };
  saveUsers();
  const token = createSession(username, req);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true, username, role: 'user' });
});

router.post('/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const u = users[username];
  if (!u || !verifyPassword(password, u.salt, u.passHash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const ban = isBannedNow(u);
  if (ban) {
    return res.status(403).json({
      error: ban.permanent ? `You are banned. ${ban.reason}` : `Timed out until ${new Date(ban.until).toLocaleString()}. ${ban.reason}`,
    });
  }
  const token = createSession(username, req);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true, username, role: u.role });
});

router.post('/auth/logout', (req, res) => {
  const tok = parseCookies(req)[COOKIE];
  if (tok) { delete sessions[tok]; saveSessions(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

/* discord: start oauth */
router.get('/auth/discord/start', (req, res) => {
  if (!DISCORD.configured) return res.status(501).send('Discord login is not configured on this server yet.');
  const state = crypto.randomBytes(12).toString('hex');
  oauthStates.add(state);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  res.redirect(DISCORD.authorizeUrl(req, state));
});

/* discord: callback — links to logged-in account, or logs in / registers by discord id */
router.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) return res.status(400).send('Invalid Discord state');
    oauthStates.delete(state);
    const d = await DISCORD.exchange(code, req);
    const profile = {
      id: d.id, username: d.global_name || d.username,
      avatar: DISCORD.avatarUrl(d),
    };
    // link into current session if there is one
    const current = userFromReq(req);
    if (current) {
      current.account.discord = profile;
      saveUsers();
      return res.redirect('/?linked=discord');
    }
    // else find an account already linked to this discord id
    const linked = Object.entries(users).find(([, a]) => a.discord && a.discord.id === d.id);
    if (linked) {
      const [uname, acc] = linked;
      const ban = isBannedNow(acc);
      if (ban) return res.status(403).send('Your account is banned.');
      const token = createSession(uname, req);
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      return res.redirect('/');
    }
    // auto-register an account named after the discord user
    let uname = (d.global_name || d.username || 'discord-user').replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 20) || 'discord-user';
    while (users[uname]) uname = uname.slice(0, 16) + '_' + crypto.randomBytes(2).toString('hex');
    users[uname] = { passHash: '', salt: '', role: 'user', createdAt: Date.now(), banned: false, discord: profile, discordOnly: true };
    saveUsers();
    const token = createSession(uname, req);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Discord login failed: ' + (e.message || 'unknown'));
  }
});

router.get('/auth/discord/status', (_req, res) => {
  res.json({ configured: DISCORD.configured });
});

/* public: who is online right now (usernames only, last 5 min) */
router.get('/api/online-users', (_req, res) => {
  const now = Date.now();
  const names = new Set();
  for (const s of Object.values(sessions)) {
    if (now - s.lastSeen < 5 * 60 * 1000) names.add(s.user);
  }
  res.json([...names]);
});

/* discord app config (admin) — used by the desktop app for Rich Presence */
const DISCORD_APP_FILE = path.join(DATA_DIR, 'discord-app.json');
router.get('/admin/api/discord-app', requireAdmin, (_req, res) => {
  let clientId = process.env.DISCORD_CLIENT_ID || null;
  try {
    const cfg = JSON.parse(fs.readFileSync(DISCORD_APP_FILE, 'utf8'));
    if (cfg.clientId) clientId = cfg.clientId;
  } catch {}
  res.json({ clientId });
});
router.post('/admin/api/discord-app', requireAdmin, (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  if (!/^[0-9]{15,25}$/.test(clientId)) return res.status(400).json({ error: 'Discord application ID must be 15-25 digits' });
  fs.writeFileSync(DISCORD_APP_FILE, JSON.stringify({ clientId }, null, 2));
  res.json({ ok: true, clientId, note: 'Restart the Wicked Player app to activate Rich Presence.' });
});

/* ============================================================
   ADMIN API (role: admin)
============================================================ */
function requireAdmin(req, res, next) {
  const u = userFromReq(req);
  if (!u || u.account.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  req.authUser = u;
  next();
}

router.get('/admin/api/users', requireAdmin, (req, res) => {
  const out = Object.entries(users).map(([name, a]) => ({
    username: name,
    role: a.role,
    createdAt: a.createdAt,
    banned: !!a.banned,
    bannedUntil: a.bannedUntil || null,
    banReason: a.banReason || null,
    discord: a.discord || null,
    discordOnly: !!a.discordOnly,
  }));
  // attach lastSeen from sessions
  const seen = {};
  for (const s of Object.values(sessions)) {
    if (!seen[s.user] || seen[s.user] < s.lastSeen) seen[s.user] = s.lastSeen;
  }
  for (const u of out) u.lastSeen = seen[u.username] || null;
  out.sort((a, b) => (b.lastSeen || b.createdAt || 0) - (a.lastSeen || a.createdAt || 0));
  res.json(out);
});

router.post('/admin/api/create', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!/^[a-zA-Z0-9_\-\.]{2,20}$/.test(username)) return res.status(400).json({ error: 'bad username' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short (4+)' });
  if (users[username]) return res.status(409).json({ error: 'username taken' });
  const { salt, hash } = hashPassword(password);
  users[username] = { passHash: hash, salt, role, createdAt: Date.now(), banned: false };
  saveUsers();
  res.json({ ok: true });
});

router.post('/admin/api/delete', requireAdmin, (req, res) => {
  const username = String(req.body.username || '');
  if (username === req.authUser.username) return res.status(400).json({ error: "can't delete yourself" });
  if (username === ADMIN_USER) return res.status(400).json({ error: "can't delete the primary admin" });
  if (!users[username]) return res.status(404).json({ error: 'no such user' });
  delete users[username];
  for (const [tok, s] of Object.entries(sessions)) { if (s.user === username) delete sessions[tok]; }
  saveUsers(); saveSessions();
  res.json({ ok: true });
});

router.post('/admin/api/ban', requireAdmin, (req, res) => {
  const username = String(req.body.username || '');
  const { until, reason } = req.body; // until: null = permanent, else ms timestamp
  const u = users[username];
  if (!u) return res.status(404).json({ error: 'no such user' });
  if (u.role === 'admin' && username !== req.authUser.username) return res.status(400).json({ error: "can't ban another admin" });
  u.banned = true;
  u.bannedUntil = until || null;
  u.banReason = String(reason || '').slice(0, 140);
  saveUsers();
  res.json({ ok: true, username, until: u.bannedUntil });
});

router.post('/admin/api/unban', requireAdmin, (req, res) => {
  const u = users[String(req.body.username || '')];
  if (!u) return res.status(404).json({ error: 'no such user' });
  u.banned = false; u.bannedUntil = null; u.banReason = null;
  saveUsers();
  res.json({ ok: true });
});

router.post('/admin/api/role', requireAdmin, (req, res) => {
  const u = users[String(req.body.username || '')];
  if (!u) return res.status(404).json({ error: 'no such user' });
  u.role = req.body.role === 'admin' ? 'admin' : 'user';
  saveUsers();
  res.json({ ok: true, role: u.role });
});

router.post('/admin/api/password', requireAdmin, (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const u = users[username];
  if (!u) return res.status(404).json({ error: 'no such user' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short' });
  const { salt, hash } = hashPassword(password);
  u.salt = salt; u.passHash = hash;
  saveUsers();
  res.json({ ok: true });
});

/* online now: from live sessions seen in the last 5 minutes */
router.get('/admin/api/online', requireAdmin, (_req, res) => {
  const now = Date.now();
  const online = [];
  for (const [tok, s] of Object.entries(sessions)) {
    if (now - s.lastSeen < 5 * 60 * 1000) {
      online.push({ username: s.user, lastSeen: s.lastSeen, ip: s.ip, ua: s.ua });
    }
  }
  online.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json(online);
});

/* recent logins / activity log (sessions with the newest tokens) */
router.get('/admin/api/logins', requireAdmin, (_req, res) => {
  const rows = Object.entries(sessions)
    .map(([tok, s]) => ({ user: s.user, created: s.created, lastSeen: s.lastSeen, ip: s.ip, ua: s.ua }))
    .sort((a, b) => b.created - a.created)
    .slice(0, 100);
  res.json(rows);
});

/* ============================================================
   MIDDLEWARE: gate the app behind login; block banned users
============================================================ */
const PUBLIC_PREFIXES = [
  '/auth/', '/api/status', '/assets/', '/enhance.js', '/wicked-icon.svg',
  '/pitch-worklet.js', '/media/', '/genre-art', '/favicon',
];
const PROTECTED_PREFIXES = [
  '/search', '/suggest', '/radio', '/stream', '/audio', '/lyrics', '/resolve',
  '/import', '/library', '/upload', '/api/', '/genre-art-refresh', '/discord/say',
];
function isPublicPath(p) {
  if (p === '/api/online-users' || p === '/genre-art') return true;
  if (PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) return true;
  return false;
}

const gate = (req, res, next) => {
  const p = req.path;
  if (isPublicPath(p)) return next();

  // admin panel page itself is served only to admins
  if (p === '/admin' || p === '/admin/') {
    const u = userFromReq(req);
    if (!u) return serveFile(res, 'login.html');
    if (isBannedNow(u)) return serveFile(res, 'banned.html', 403);
    if (u.account.role !== 'admin') return res.status(403).send('Admin only. Log in with an admin account.');
    return serveFile(res, 'admin.html');
  }

  // API/data protection
  if (PROTECTED_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) {
    const u = userFromReq(req);
    if (!u) return res.status(401).json({ error: 'Login required', auth: true });
    const ban = isBannedNow(u.account);
    if (ban) {
      return res.status(403).json({
        error: ban.permanent ? `Banned: ${ban.reason}` : `Timed out until ${new Date(ban.until).toLocaleString()}`,
        banned: true,
      });
    }
    return next();
  }

  // everything else that's not public: let it pass (static files, misc)
  next();
};

/* the main gate for "/" — no session = login page, banned = banned page,
   logged in = the app UI with the user injected */
function gateHome(sendIndex) {
  return (req, res) => {
    const u = userFromReq(req);
    if (!u) return serveFile(res, 'login.html');
    const ban = isBannedNow(u.account);
    if (ban) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'banned.html'), 'utf8')
        .replace('__REASON__', ban.permanent ? ban.reason : `${ban.reason} — until ${new Date(ban.until).toLocaleString()}`);
      return res.status(403).type('html').send(html);
    }
    const html = fs.readFileSync(sendIndex(), 'utf8');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(injectUser(html, u));
  };
}

/* account chip: small script served to the app so users see/logout their account */
router.get('/account-chip.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'account-chip.js'));
});

module.exports = { router, gate, gateHome, userFromReq, isBannedNow, users, sessions, saveUsers, saveSessions, COOKIE };