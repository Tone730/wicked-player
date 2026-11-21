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
const { readJSON, atomicWriteJSON, tryWriteJSON } = require('./lib/store');
const accessLog = require('./lib/access-log');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMM_FILE = path.join(DATA_DIR, 'community.json');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'app-activity.json');
const LISTEN_FILE = path.join(DATA_DIR, 'listen-stats.json');
const LIB_FILE = path.join(DATA_DIR, 'library.json');
const ERR_FILE = path.join(DATA_DIR, 'errors.json');
const SEC_FILE = path.join(DATA_DIR, 'security.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const VISITOR_COOKIE = 'wpvid';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/* ---------------- stores ---------------- */
let users = {};     // username -> account
let sessions = {};  // token -> { user, created, lastSeen, ip, ua }
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}

/* Accounts and sessions are written atomically and synchronously. The old
   200ms debounced truncate-write could report "account created" and then lose
   the account entirely if the process stopped before the timer fired. */
function saveUsers() {
  try { atomicWriteJSON(USERS_FILE, users); return true; }
  catch (e) { process.stderr.write(`[auth] account save failed: ${e && e.message || e}\n`); return false; }
}
function saveSessions() {
  try { atomicWriteJSON(SESSIONS_FILE, sessions); return true; }
  catch (e) { process.stderr.write(`[auth] session save failed: ${e && e.message || e}\n`); return false; }
}

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
const SECURE_COOKIE = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
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
/* Non-mutating identity lookup (used by the access log middleware). */
function peekUser(req) {
  const tok = parseCookies(req)[COOKIE];
  const s = tok && sessions[tok];
  const u = s && users[s.user];
  return u ? { username: s.user, role: u.role } : null;
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
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) throw new Error('ADMIN_PASS must be set in .env');
if (!process.env.ADMIN_KEY) throw new Error('ADMIN_KEY must be set in .env');
if (!users[ADMIN_USER]) {
  const { salt, hash } = hashPassword(ADMIN_PASS);
  users[ADMIN_USER] = { passHash: hash, salt, role: 'admin', createdAt: Date.now(), banned: false };
  saveUsers();
  console.log(`[auth] admin account created -> ${ADMIN_USER}`);
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
function premiumProfile(name) {
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  return (comm.profiles || {})[name] || null;
}

function injectUser(html, user) {
  if (!user) return html;
  const pp = premiumProfile(user.username);
  const info = JSON.stringify({
    username: user.username,
    role: user.account.role,
    discord: user.account.discord || null,
    premium: premiumActive(pp),
    premiumUntil: pp && pp.premiumUntil || null,
  });
  // Inject at the START of <head> so bundled scripts (account chip, community
  // identity) can read the session user before they initialize.
  return html.replace('<head>', `<head>\n<script>window.__WP_USER=${info.replace(/</g, '\\u003c')};</script>`);
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
  const pp = premiumProfile(u.username);
  res.json({ user: {
    username: u.username, role: a.role, discord: a.discord || null,
    createdAt: a.createdAt,
    premium: premiumActive(pp),
    premiumUntil: pp && pp.premiumUntil || null,
    referralCode: 'WP-' + u.username,
  } });
});

router.post('/auth/register', (req, res) => {
  if (String(process.env.ALLOW_REGISTRATION ?? '1') !== '1') {
    return res.status(403).json({ error: 'Registration is disabled. Ask the admin for an account.' });
  }
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 2-20 chars, letters/numbers/_ - .' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (users[username]) return res.status(409).json({ error: 'That username is taken' });
  const { salt, hash } = hashPassword(password);
  users[username] = { passHash: hash, salt, role: 'user', createdAt: Date.now(), banned: false };
  /* Persist BEFORE telling the client it worked, and roll back on failure. */
  if (!saveUsers()) {
    delete users[username];
    return res.status(500).json({ error: 'Could not save your account. Please try again.' });
  }
  /* New accounts get a real community profile immediately — otherwise their
     public profile 404s until the first manual profile save. */
  try {
    const comm = readJsonSafe(COMM_FILE, { profiles: {} });
    comm.profiles = comm.profiles || {};
    if (!comm.profiles[username]) {
      comm.profiles[username] = { friends: [], requests: [], outgoing: [], createdAt: Date.now() };
      atomicWriteJSON(COMM_FILE, comm);
    }
  } catch (e) {
    process.stderr.write(`[auth] profile bootstrap failed for ${username}: ${e && e.message || e}\n`);
  }
  const token = createSession(username, req);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ${SECURE_COOKIE}Max-Age=2592000`);
  appendActivity('register', req, { username });
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
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ${SECURE_COOKIE}Max-Age=2592000`);
  res.json({ ok: true, username, role: u.role });
});

router.post('/auth/logout', (req, res) => {
  const tok = parseCookies(req)[COOKIE];
  if (tok) { delete sessions[tok]; saveSessions(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; ${SECURE_COOKIE}Max-Age=0`);
  res.json({ ok: true });
});

/* change own password (session required; discord-only accounts set initial password) */
router.post('/auth/change-password', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required' });
  const next = String(req.body.next || '');
  if (next.length < 4) return res.status(400).json({ error: 'New password must be 4+ characters' });
  const acc = u.account;
  if (!acc.discordOnly && acc.passHash) {
    const cur = String(req.body.current || '');
    if (!verifyPassword(cur, acc.salt, acc.passHash)) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
  }
  const { salt, hash } = hashPassword(next);
  acc.salt = salt; acc.passHash = hash; acc.discordOnly = false;
  saveUsers();
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
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ${SECURE_COOKIE}Max-Age=2592000`);
      return res.redirect('/');
    }
    // auto-register an account named after the discord user
    let uname = (d.global_name || d.username || 'discord-user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20) || 'discord-user';
    while (users[uname]) uname = uname.slice(0, 16) + '_' + crypto.randomBytes(2).toString('hex');
    users[uname] = { passHash: '', salt: '', role: 'user', createdAt: Date.now(), banned: false, discord: profile, discordOnly: true };
    saveUsers();
    const token = createSession(uname, req);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ${SECURE_COOKIE}Max-Age=2592000`);
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Discord login failed: ' + (e.message || 'unknown'));
  }
});

router.get('/auth/discord/status', (_req, res) => {
  res.json({ configured: DISCORD.configured });
});

/* local prefs (desktop app home server). Local-only by nature: the desktop
   app reads it from its own bundled backend to decide which server to open. */
const LOCAL_PREFS_FILE = path.join(DATA_DIR, 'local-prefs.json');
router.get('/local/prefs', (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LOCAL_PREFS_FILE, 'utf8'))); }
  catch { res.json({ homeServer: null }); }
});
router.post('/local/prefs', (req, res) => {
  let homeServer = req.body.homeServer || null;
  if (homeServer) {
    homeServer = String(homeServer).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(homeServer)) homeServer = 'http://' + homeServer;
    try { const u = new URL(homeServer); if (!u.hostname) throw 0; } catch {
      return res.status(400).json({ error: 'invalid server url' });
    }
  }
  fs.writeFileSync(LOCAL_PREFS_FILE, JSON.stringify({ homeServer }, null, 2));
  res.json({ ok: true, homeServer });
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

/* now-playing presence: logged-in clients report what they're playing */
router.post('/api/presence/np', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  comm.profiles = comm.profiles || {};
  const prof = comm.profiles[u.username] || {};
  prof.np = {
    title: String((req.body && req.body.title) || '').slice(0, 120),
    artist: String((req.body && req.body.artist) || '').slice(0, 120),
    playing: !!(req.body && req.body.playing),
    at: Date.now(),
  };
  comm.profiles[u.username] = prof;
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  res.json({ ok: true });
});

/* ---------- premium redemption system ----------
   Codes (WK-XXXXXX / premium codes) live in ../data/codes.json via server.js.
   A user submits a code -> it activates time-limited premium on their
   community profile and logs a redemption the admin can review/revoke. */

function readJsonSafe(file, fallback) {
  return readJSON(file, fallback);
}
function appendActivity(type, req, extra) {
  const u = userFromReq(req);
  const row = {
    type,
    user: u ? u.username : "guest",
    at: Date.now(),
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "",
    ua: String(req.headers["user-agent"] || "").slice(0, 220),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  const log = readJsonSafe(ACTIVITY_FILE, []);
  log.unshift(row);
  tryWriteJSON(ACTIVITY_FILE, log.slice(0, 1000));
  return row;
}

/* ---------------- anonymous / signed-in usage visibility ----------------
   Every active player (even logged out) gets an opaque wpvid cookie. We store
   only a hash of that id — no IP or user agent by default — plus the event
   kind, an optional session user, and what is playing. The admin panel can
   therefore see "someone is using the app right now" without any account. */
let usageState = null;
function loadUsage() {
  if (usageState) return usageState;
  const saved = readJsonSafe(USAGE_FILE, {});
  usageState = {
    visitors: saved && typeof saved.visitors === 'object' && saved.visitors ? saved.visitors : {},
    recent: Array.isArray(saved.recent) ? saved.recent : [],
    days: saved && typeof saved.days === 'object' && saved.days ? saved.days : {},
  };
  return usageState;
}
const usageCooldown = new Map();   // vid|kind|track -> last timestamp
const liveVisitors = new Map();    // vid hash -> latest live row
let usageEmitter = null;
function setUsageEmitter(fn) { usageEmitter = fn; }

function usageHeartbeat(req, res) {
  try {
    const cookies = parseCookies(req);
    let vid = cookies[VISITOR_COOKIE];
    let isNew = false;
    if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
      vid = crypto.randomBytes(16).toString('hex');
      isNew = true;
      res.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${vid}; Path=/; HttpOnly; SameSite=Lax; ${SECURE_COOKIE}Max-Age=2592000`);
    }
    const vidHash = crypto.createHash('sha256').update(vid).digest('hex').slice(0, 16);
    const u = peekUser(req);
    const body = req.body || {};
    const kind = String(body.kind || 'heartbeat').slice(0, 24);
    const playing = !!body.playing;
    const track = body.track && typeof body.track === 'object'
      ? { name: String(body.track.name || '').slice(0, 120), artist: String(body.track.artist || '').slice(0, 120) }
      : null;
    const platform = String(body.platform || 'web').slice(0, 24);

    /* One row per visitor per kind/track per 30s is plenty to answer
       "are they using it?" without letting a broken tab spam the log. */
    const dedupeKey = `${vidHash}|${kind}|${track ? track.name : ''}`;
    const now = Date.now();
    if (now - (usageCooldown.get(dedupeKey) || 0) < 30000) {
      return res.json({ ok: true, deduped: true });
    }
    usageCooldown.set(dedupeKey, now);

    const st = loadUsage();
    const row = {
      at: now, vid: vidHash, user: u ? u.username : null, kind,
      playing, track, platform,
    };
    st.recent.unshift(row);
    if (st.recent.length > 1200) st.recent.length = 1200;
    const day = new Date(now).toISOString().slice(0, 10);
    st.days[day] = st.days[day] || { anon: 0, auth: 0, total: 0 };
    st.days[day][u ? 'auth' : 'anon']++;
    st.days[day].total++;
    const vis = st.visitors[vidHash] || { first: now, last: now, events: 0, user: null, platform };
    vis.last = now; vis.events++;
    if (u) vis.user = u.username;
    vis.platform = platform;
    st.visitors[vidHash] = vis;
    const visitorKeys = Object.keys(st.visitors);
    if (visitorKeys.length > 2000) {
      visitorKeys.sort((a, b) => st.visitors[a].last - st.visitors[b].last);
      for (const k of visitorKeys.slice(0, visitorKeys.length - 1500)) delete st.visitors[k];
    }
    tryWriteJSON(USAGE_FILE, st);

    const live = { ...row, vid: vidHash };
    liveVisitors.set(vidHash, live);
    if (liveVisitors.size > 500) {
      const oldest = [...liveVisitors.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) liveVisitors.delete(oldest[0]);
    }
    try { if (usageEmitter) usageEmitter(live); } catch {}
    res.json({ ok: true, at: now, vid: isNew ? 'new' : 'known' });
  } catch (e) {
    process.stderr.write(`[usage] heartbeat failed: ${e && e.message || e}\n`);
    res.json({ ok: false });
  }
}
function premiumActive(p) {
  if (!p) return false;
  if (p.premiumUntil) return Date.now() < p.premiumUntil;
  return !!p.premium;
}

router.post("/api/reward/redeem", (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: "Login required", auth: true });
  const code = String(req.body.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ error: "Enter your code" });

  const codes = readJsonSafe(CODES_FILE, {});
  const entry = codes[code];
  if (!entry) return res.status(404).json({ error: "Unknown code. Check for typos." });
  if (entry.used) return res.status(409).json({ error: "That code was already used" });

  const days = entry.days || (entry.type === "jackpot" ? 7 : 30);
  const until = Date.now() + days * 86400000;

  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  comm.profiles = comm.profiles || {};
  const prof = comm.profiles[u.username] || {};
  const prevUntil = prof.premiumUntil && Date.now() < prof.premiumUntil ? prof.premiumUntil : 0;
  prof.premium = true;
  prof.premiumUntil = Math.max(prevUntil, until);
  prof.premiumSource = "code:" + code;
  comm.profiles[u.username] = prof;
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));

  codes[code] = { used: true, usedBy: u.username, usedAt: Date.now(), days };
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));

  const log = readJsonSafe(path.join(DATA_DIR, "redemptions.json"), []);
  log.unshift({ user: u.username, code: code, days: days, at: Date.now(), status: "active", until: prof.premiumUntil });
  fs.writeFileSync(path.join(DATA_DIR, "redemptions.json"), JSON.stringify(log.slice(0, 200), null, 2));

  res.json({ ok: true, days: days, until: prof.premiumUntil });
});

/* ---------- premium gifting + referral credits ---------- */
function grantPremiumDays(comm, name, days, source) {
  comm.profiles = comm.profiles || {};
  const prof = comm.profiles[name] || {};
  const prev = prof.premiumUntil && Date.now() < prof.premiumUntil ? prof.premiumUntil : Date.now();
  prof.premium = true;
  prof.premiumUntil = prev + (Number(days) || 30) * 86400000;
  prof.premiumSource = source;
  comm.profiles[name] = prof;
  return prof;
}
function logRedemption(row) {
  const log = readJsonSafe(path.join(DATA_DIR, 'redemptions.json'), []);
  log.unshift(row);
  try { fs.writeFileSync(path.join(DATA_DIR, 'redemptions.json'), JSON.stringify(log.slice(0, 200), null, 2)); } catch {}
}

/* A premium member can gift 7/30 days to another registered account.
   Rate-limited to one gift per 7 days to prevent runaway granting. */
router.post('/api/premium/gift', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  comm.profiles = comm.profiles || {};
  const sender = comm.profiles[u.username] || {};
  if (!premiumActive(sender)) return res.status(403).json({ error: 'Premium is required to gift it' });
  if (sender.lastGiftAt && Date.now() - sender.lastGiftAt < 7 * 86400000) {
    return res.status(429).json({ error: 'You can send one gift every 7 days' });
  }
  const to = String(req.body.user || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(to)) return res.status(400).json({ error: 'Enter a valid username' });
  if (!users[to]) return res.status(404).json({ error: "No account named '" + to + "'" });
  if (to === u.username) return res.status(400).json({ error: 'You cannot gift yourself' });
  const days = Number(req.body.days) === 7 ? 7 : 30;
  const prof = grantPremiumDays(comm, to, days, 'gift:' + u.username);
  sender.lastGiftAt = Date.now();
  sender.giftedTo = (sender.giftedTo || []).filter((g) => g && g.user !== to);
  sender.giftedTo.unshift({ user: to, days, at: Date.now() });
  sender.giftedTo = sender.giftedTo.slice(0, 50);
  comm.profiles[u.username] = sender;
  try { fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2)); } catch {}
  logRedemption({ user: to, code: 'gift:' + u.username, days, at: Date.now(), status: 'active', until: prof.premiumUntil });
  appendActivity('premium-gift', req, { to, days });
  res.json({ ok: true, user: to, days, until: prof.premiumUntil });
});

function referralOwner(code) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw.startsWith('WP-')) return null;
  const name = raw.slice(3);
  return Object.keys(users).find((n) => n.toUpperCase() === name) || null;
}
function referralInfo(name) {
  const a = users[name] || {};
  return {
    code: 'WP-' + name,
    count: Number(a.referralCount) || 0,
    rewarded: Number(a.referralRewarded) || 0,
    referredBy: a.referredBy || null,
    nextRewardAt: 3,
  };
}
router.get('/api/referrals/me', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  res.json(referralInfo(u.username));
});
router.post('/api/referrals/apply', (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const owner = referralOwner(req.body.code);
  if (!owner) return res.status(404).json({ error: 'Unknown referral code' });
  if (owner === u.username) return res.status(400).json({ error: 'You cannot refer yourself' });
  const me = users[u.username];
  if (me.referredBy) return res.status(409).json({ error: 'You already used a referral code' });
  const ref = users[owner];
  const count = (Number(ref.referralCount) || 0) + 1;
  ref.referralCount = count;
  me.referredBy = owner;
  saveUsers();

  // Every 3 referrals rewards the referrer with 7 days of premium.
  const rewarded = Number(ref.referralRewarded) || 0;
  if (count >= (rewarded + 1) * 3) {
    const comm = readJsonSafe(COMM_FILE, { profiles: {} });
    const prof = grantPremiumDays(comm, owner, 7, 'referral:' + count);
    try { fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2)); } catch {}
    ref.referralRewarded = rewarded + 1;
    saveUsers();
    logRedemption({ user: owner, code: 'referral:' + count, days: 7, at: Date.now(), status: 'active', until: prof.premiumUntil });
    appendActivity('referral-reward', req, { owner, count });
  }
  res.json({ ok: true, ...referralInfo(u.username) });
});

/* premium request: users without a code can ask the admin */
router.post("/api/premium/request", (req, res) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: "Login required", auth: true });
  const msg = String(req.body.message || "").slice(0, 200);
  const reqs = readJsonSafe(path.join(DATA_DIR, "premium-requests.json"), []);
  if (reqs.find(function (r) { return r.user === u.username && r.status === "pending"; })) {
    return res.status(409).json({ error: "You already have a pending request" });
  }
  reqs.unshift({ user: u.username, message: msg, at: Date.now(), status: "pending" });
  fs.writeFileSync(path.join(DATA_DIR, "premium-requests.json"), JSON.stringify(reqs.slice(0, 100), null, 2));
  res.json({ ok: true });
});

/* app usage + download telemetry sent by the desktop client */
router.post("/api/stats/app-open", function (req, res) {
  const row = appendActivity("open", req, {
    version: String(req.body.version || "").slice(0, 40),
    platform: String(req.body.platform || "").slice(0, 40),
    mode: String(req.body.mode || "").slice(0, 20),
  });
  res.json({ ok: true, at: row.at });
});
router.post("/api/stats/download", function (req, res) {
  const row = appendActivity("download", req, {
    version: String(req.body.version || "").slice(0, 40),
    platform: String(req.body.platform || "").slice(0, 40),
    source: String(req.body.source || "ui").slice(0, 40),
  });
  res.json({ ok: true, at: row.at });
});

/* Public (pre-gate) usage heartbeat — works for signed-out players too. */
router.post('/api/usage/heartbeat', usageHeartbeat);

router.get("/admin/api/premium-requests", requireAdmin, function (_req, res) {
  res.json(readJsonSafe(path.join(DATA_DIR, "premium-requests.json"), []));
});
router.get("/admin/api/redemptions", requireAdmin, function (_req, res) {
  res.json(readJsonSafe(path.join(DATA_DIR, "redemptions.json"), []).slice(0, 100));
});
router.post("/admin/api/premium-request/decide", requireAdmin, function (req, res) {
  const user = String(req.body.user || "");
  const lifetime = req.body.days === "lifetime" || req.body.lifetime === true;
  const decision = req.body.decision === "approve" ? "approved" : "denied";
  const reqs = readJsonSafe(path.join(DATA_DIR, "premium-requests.json"), []);
  const entry = reqs.find(function (r) { return r.user === user && r.status === "pending"; });
  if (!entry) return res.status(404).json({ error: "No pending request for that user" });
  entry.status = decision;
  entry.decidedAt = Date.now();
  fs.writeFileSync(path.join(DATA_DIR, "premium-requests.json"), JSON.stringify(reqs, null, 2));
  if (decision === "approved") {
    const comm = readJsonSafe(COMM_FILE, { profiles: {} });
    comm.profiles = comm.profiles || {};
    const prof = comm.profiles[user] || {};
    if (lifetime) {
      prof.premium = true;
      prof.premiumUntil = null;
      prof.premiumSource = "admin-lifetime";
    } else {
      const d = Number(req.body.days) || 30;
      const prevUntil = prof.premiumUntil && Date.now() < prof.premiumUntil ? prof.premiumUntil : Date.now();
      prof.premium = true;
      prof.premiumUntil = prevUntil + d * 86400000;
      prof.premiumSource = "admin-approved";
    }
    comm.profiles[user] = prof;
    fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  }
  res.json({ ok: true, decision: decision, lifetime: lifetime });
});

/* grant premium directly to any registered account — no pending request needed */
router.post("/admin/api/premium-grant", requireAdmin, function (req, res) {
  const user = String(req.body.user || "").trim();
  if (!user) return res.status(400).json({ error: "Username required" });
  if (!users[user]) return res.status(404).json({ error: "No account named '" + user + "' — they must sign up first" });
  const lifetime = req.body.days === "lifetime" || req.body.lifetime === true;
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  comm.profiles = comm.profiles || {};
  const prof = comm.profiles[user] || {};
  if (lifetime) {
    prof.premium = true;
    prof.premiumUntil = null;
    prof.premiumSource = "admin-lifetime";
  } else {
    var d = Number(req.body.days) || 30;
    const prevUntil = prof.premiumUntil && Date.now() < prof.premiumUntil ? prof.premiumUntil : Date.now();
    prof.premium = true;
    prof.premiumUntil = prevUntil + d * 86400000;
    prof.premiumSource = "admin-grant";
  }
  comm.profiles[user] = prof;
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  const log = readJsonSafe(path.join(DATA_DIR, "redemptions.json"), []);
  log.unshift({ user: user, code: lifetime ? "admin-lifetime" : "admin-grant:" + d + "d", days: lifetime ? 0 : d, at: Date.now(), status: "active", until: prof.premiumUntil || null });
  fs.writeFileSync(path.join(DATA_DIR, "redemptions.json"), JSON.stringify(log.slice(0, 200), null, 2));
  res.json({ ok: true, user: user, lifetime: lifetime, until: prof.premiumUntil || null });
});

router.get("/admin/api/premium-active", requireAdmin, function (_req, res) {
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  const out = [];
  for (const name in (comm.profiles || {})) {
    const p = comm.profiles[name];
    if (premiumActive(p)) {
      out.push({ user: name, until: p.premiumUntil || null, permanent: !p.premiumUntil, source: p.premiumSource || null });
    }
  }
  res.json(out);
});
router.post("/admin/api/premium-revoke", requireAdmin, function (req, res) {
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  const prof = (comm.profiles || {})[String(req.body.user || "")];
  if (!prof) return res.status(404).json({ error: "No such profile" });
  prof.premium = false; prof.premiumUntil = null; prof.premiumSource = null;
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  res.json({ ok: true });
});
const DISCORD_APP_FILE = path.join(DATA_DIR, 'discord-app.json');
router.get('/admin/api/discord-app', requireAdmin, (_req, res) => {
  let clientId = process.env.DISCORD_CLIENT_ID || null;
  let invite = process.env.DISCORD_INVITE || null;
  try {
    const cfg = JSON.parse(fs.readFileSync(DISCORD_APP_FILE, 'utf8'));
    if (cfg.clientId) clientId = cfg.clientId;
    if (cfg.invite) invite = cfg.invite;
  } catch {}
  res.json({ clientId, invite });
});
router.post('/admin/api/discord-app', requireAdmin, (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  let invite = String(req.body.invite || '').trim();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(DISCORD_APP_FILE, 'utf8')); } catch {}
  if (clientId) {
    if (!/^[0-9]{15,25}$/.test(clientId)) return res.status(400).json({ error: 'Discord application ID must be 15-25 digits' });
    cfg.clientId = clientId;
  }
  if (invite) {
    if (!/^https:\/\/discord\.gg\/[A-Za-z0-9-]+$/.test(invite) && !/^https:\/\/discord\.com\/invite\/[A-Za-z0-9-]+$/.test(invite)) {
      return res.status(400).json({ error: 'Invite must look like https://discord.gg/yourcode' });
    }
    cfg.invite = invite;
  }
  fs.writeFileSync(DISCORD_APP_FILE, JSON.stringify(cfg, null, 2));
  res.json({ ok: true, clientId: cfg.clientId || null, invite: cfg.invite || null, note: cfg.clientId ? 'Restart the app to activate Rich Presence.' : undefined });
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
  const comm = readJsonSafe(COMM_FILE, { profiles: {} }).profiles || {};
  const activity = readJsonSafe(ACTIVITY_FILE, []);
  const listens = readJsonSafe(LISTEN_FILE, {});
  const lib = readJsonSafe(LIB_FILE, { history: [] });
  const downloads = {}, opens = {}, plays = {};
  for (const a of activity) {
    if (a.type === 'download') downloads[a.user] = (downloads[a.user] || 0) + 1;
    if (a.type === 'open') opens[a.user] = (opens[a.user] || 0) + 1;
  }
  for (const h of (lib.history || [])) plays[h.user || 'guest'] = (plays[h.user || 'guest'] || 0) + 1;

  const out = Object.entries(users).map(([name, a]) => {
    const prof = comm[name] || {};
    const st = listens[name] || {};
    const p = premiumActive(prof);
    return {
      username: name,
      role: a.role,
      createdAt: a.createdAt,
      banned: !!a.banned,
      bannedUntil: a.bannedUntil || null,
      banReason: a.banReason || null,
      discord: a.discord || null,
      discordOnly: !!a.discordOnly,
      displayName: prof.displayName || name,
      avatar: prof.avatar || null,
      status: prof.status || '',
      verified: !!prof.verified,
      premium: p,
      premiumUntil: prof.premiumUntil || null,
      premiumSource: prof.premiumSource || null,
      referralCode: 'WP-' + name,
      referralCount: Number(a.referralCount) || 0,
      referredBy: a.referredBy || null,
      giftedTo: (prof.giftedTo || []).length,
      downloads: downloads[name] || 0,
      opens: opens[name] || 0,
      minutes: Math.round((st.total || 0) / 60),
      plays: plays[name] || 0,
      badges: prof.badges || [],
    };
  });
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
  if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(username)) return res.status(400).json({ error: 'bad username' });
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
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  const online = [];
  for (const [tok, s] of Object.entries(sessions)) {
    if (now - s.lastSeen < 5 * 60 * 1000) {
      const npRaw = (comm.profiles[s.user] || {}).np || null;
      const np = npRaw && now - npRaw.at < 3 * 60 * 1000
        ? { title: npRaw.title, artist: npRaw.artist, playing: npRaw.playing }
        : null;
      online.push({ username: s.user, lastSeen: s.lastSeen, ip: s.ip, ua: s.ua, np });
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

/* full activity trail: app opens, downloads, listening, rewards, errors, security */
router.get('/admin/api/activity', requireAdmin, (_req, res) => {
  const activity = readJsonSafe(ACTIVITY_FILE, []);
  const listens = readJsonSafe(LISTEN_FILE, {});
  const lib = readJsonSafe(LIB_FILE, { history: [] });
  const rewards = readJsonSafe(path.join(DATA_DIR, 'rewards.json'), { issued: [] }).issued || [];
  const redemptions = readJsonSafe(path.join(DATA_DIR, 'redemptions.json'), []);
  const errors = readJsonSafe(ERR_FILE, []);
  const security = readJsonSafe(SEC_FILE, []);
  const history = (lib.history || []).map((h) => ({
    type: 'listen', user: h.user || 'guest', at: h.playedAt || 0,
    title: h.name, artist: h.artist, source: h.src, stream: h.stream_url,
  }));
  const logins = Object.entries(sessions).map(([tok, s]) => ({
    type: 'login', user: s.user, at: s.created || s.lastSeen || 0,
    ip: s.ip, ua: s.ua, lastSeen: s.lastSeen,
  }));
  const rewardRows = rewards.map((r) => ({ type: 'reward', user: r.user, at: r.at, title: r.label, code: r.code, claimed: r.claimed }));
  const redeemRows = redemptions.map((r) => ({ type: 'redeem', user: r.user, at: r.at, title: r.code, days: r.days }));
  const errorRows = errors.map((e) => ({ type: 'error', user: '-', at: e.at, title: e.kind, detail: e.message }));
  const securityRows = security.map((e) => ({ type: 'security', user: e.actor, at: e.at, title: e.event, detail: e.detail }));
  const all = [...activity, ...history, ...logins, ...rewardRows, ...redeemRows, ...errorRows, ...securityRows]
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const byUser = {};
  for (const n of Object.keys(listens)) {
    const key = String(n).toLowerCase();
    const cur = byUser[key] || { minutes: 0, plays: 0, downloads: 0, opens: 0 };
    cur.minutes += Math.round(((listens[n] || {}).total || 0) / 60);
    cur.plays += (lib.history || []).filter((h) => String(h.user || 'guest').toLowerCase() === key).length;
    cur.downloads += activity.filter((a) => a.type === 'download' && String(a.user || '').toLowerCase() === key).length;
    cur.opens += activity.filter((a) => a.type === 'open' && String(a.user || '').toLowerCase() === key).length;
    byUser[key] = cur;
  }
  res.json({ events: all.slice(0, 500), byUser, totals: { events: all.length } });
});

router.get('/admin/api/listening', requireAdmin, (_req, res) => {
  const listens = readJsonSafe(LISTEN_FILE, {});
  const lib = readJsonSafe(LIB_FILE, { history: [] });
  const out = Object.entries(listens).map(([user, st]) => {
    const mine = (lib.history || []).filter((h) => (h.user || 'guest') === user);
    const artists = {};
    for (const h of mine) { const a = (h.artist || 'Unknown').split(',')[0].trim() || 'Unknown'; artists[a] = (artists[a] || 0) + 1; }
    const top = Object.entries(artists).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));
    return { user, minutes: Math.round((st.total || 0) / 60), months: st.months || {}, plays: mine.length, topArtists: top };
  }).sort((a, b) => b.minutes - a.minutes);
  res.json(out);
});

router.get('/admin/api/system', requireAdmin, (_req, res) => {
  res.json({
    errors: readJsonSafe(ERR_FILE, []).slice(0, 100),
    security: readJsonSafe(SEC_FILE, []).slice(0, 100),
    activityCounts: (readJsonSafe(ACTIVITY_FILE, [])).reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {}),
    generatedAt: Date.now(),
  });
});

/* ---------------- expanded observability endpoints ---------------- */
router.get('/admin/api/usage/live', requireAdmin, (_req, res) => {
  const now = Date.now();
  const rows = [...liveVisitors.values()]
    .filter((r) => now - r.at < 2 * 60 * 1000)
    .sort((a, b) => b.at - a.at);
  res.json({
    now,
    total: rows.length,
    anon: rows.filter((r) => !r.user).length,
    auth: rows.filter((r) => !!r.user).length,
    playing: rows.filter((r) => r.playing).length,
    rows,
  });
});
router.get('/admin/api/usage/recent', requireAdmin, (req, res) => {
  const st = loadUsage();
  const n = Math.max(0, Math.min(parseInt(req.query.limit, 10) || 200, 1200));
  res.json({ count: st.recent.length, rows: st.recent.slice(0, n) });
});
router.get('/admin/api/usage/summary', requireAdmin, (req, res) => {
  const st = loadUsage();
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 14, 90));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = st.days[key] || { anon: 0, auth: 0, total: 0 };
    out.push({ key, anon: v.anon || 0, auth: v.auth || 0, total: v.total || 0 });
  }
  res.json(out);
});
router.get('/admin/api/visitors', requireAdmin, (_req, res) => {
  const st = loadUsage();
  const now = Date.now();
  const rows = Object.entries(st.visitors).map(([vid, v]) => ({
    vid, first: v.first, last: v.last, events: v.events || 0,
    user: v.user || null, platform: v.platform || 'web',
    online: now - v.last < 2 * 60 * 1000,
  })).sort((a, b) => b.last - a.last).slice(0, 300);
  res.json(rows);
});

/* Unified log view: normalises every store to { ts, kind, actor, message, meta }. */
router.get('/admin/api/logs', requireAdmin, (req, res) => {
  const types = String(req.query.type || 'all').toLowerCase();
  const all = new Set(types === 'all' ? [] : types.split(',').map((s) => s.trim()));
  const include = (k) => types === 'all' || all.has(k);
  const rows = [];
  const push = (kind, at, actor, message, meta) => {
    if (include(kind)) rows.push({ ts: at || 0, kind, actor: actor || '-', message: String(message || '').slice(0, 500), meta: meta || null });
  };
  for (const e of readJsonSafe(ERR_FILE, [])) push('error', e.at, '-', e.message, { errorKind: e.kind });
  for (const e of readJsonSafe(SEC_FILE, [])) push('security', e.at, e.actor, `${e.event}: ${e.detail || ''}`);
  for (const a of readJsonSafe(ACTIVITY_FILE, [])) {
    if (include('activity')) rows.push({ ts: a.at || 0, kind: 'activity', actor: a.user || 'guest', message: `${a.type}${a.title ? ': ' + a.title : ''}`, meta: a });
  }
  const alertsRaw = readJsonSafe(path.join(DATA_DIR, 'alerts.json'), []);
  for (const a of alertsRaw) push('alert', a.ts || a.at, a.severity || '-', a.message, a.meta);
  const access = accessLog.list(1000).rows;
  for (const a of access) {
    if (include('access')) rows.push({ ts: a.ts || 0, kind: 'access', actor: a.user || (a.vid ? 'visitor:' + a.vid : 'guest'), message: `${a.method} ${a.path} -> ${a.status} (${a.ms}ms)${a.denied ? ' ' + a.denied : ''}`, meta: a });
  }
  const usage = loadUsage();
  for (const r of usage.recent) {
    if (include('usage')) rows.push({ ts: r.at || 0, kind: 'usage', actor: r.user || (r.vid ? 'visitor:' + r.vid : 'guest'), message: `${r.kind}${r.playing ? ' (playing)' : ''}${r.track && r.track.name ? ' - ' + r.track.name : ''}${r.track && r.track.artist ? ' / ' + r.track.artist : ''}`, meta: r });
  }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const n = Math.max(0, Math.min(parseInt(req.query.limit, 10) || 300, 2000));
  res.json({ count: rows.length, rows: rows.slice(0, n) });
});
router.get('/admin/api/access', requireAdmin, (req, res) => {
  res.json(accessLog.list(req.query.limit));
});

router.post('/admin/api/verified', requireAdmin, (req, res) => {
  const name = String(req.body.username || '');
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  if (!comm.profiles[name]) return res.status(404).json({ error: 'No profile for that user' });
  comm.profiles[name].verified = !!req.body.on;
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  res.json({ ok: true, verified: !!req.body.on });
});
router.post('/admin/api/badge', requireAdmin, (req, res) => {
  const name = String(req.body.username || '');
  const badge = String(req.body.badge || '');
  const allowed = ['early', 'listener', 'superlistener', 'helper', 'premium', 'verified'];
  if (!allowed.includes(badge)) return res.status(400).json({ error: 'unknown badge' });
  const comm = readJsonSafe(COMM_FILE, { profiles: {} });
  if (!comm.profiles[name]) return res.status(404).json({ error: 'No profile for that user' });
  const p = comm.profiles[name];
  p.badges = p.badges || [];
  const i = p.badges.indexOf(badge);
  if (req.body.remove) { if (i >= 0) p.badges.splice(i, 1); }
  else if (i < 0) p.badges.push(badge);
  fs.writeFileSync(COMM_FILE, JSON.stringify(comm, null, 2));
  res.json({ ok: true, badges: p.badges });
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
function isPublicPath(p, method) {
  if (p === '/api/online-users' || p === '/genre-art' || p.startsWith('/local/') || p === '/api/config/discord-invite') return true;
  // public read-only profiles + their shareable CustomRP preset
  // (single user only, never the full directory; private profiles are
  // still rejected by the profile route itself)
  if (method === 'GET' && /^\/api\/profiles\/[a-zA-Z0-9_.-]{2,20}(\/crp)?$/.test(p)) return true;
  if (PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) return true;
  return false;
}

const gate = (req, res, next) => {
  const p = req.path;
  if (isPublicPath(p, req.method)) return next();

  // admin panel page itself is served only to admins
  if (p === '/admin' || p === '/admin/') {
    const u = userFromReq(req);
    if (!u) return serveFile(res, 'login.html');
    if (isBannedNow(u)) return serveFile(res, 'banned.html', 403);
    if (u.account.role !== 'admin') {
      accessLog.recordDenied(req, 403, 'admin-page-non-admin');
      return res.status(403).send('Admin only. Log in with an admin account.');
    }
    return serveFile(res, 'admin.html');
  }

  // API/data protection
  if (PROTECTED_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) {
    const u = userFromReq(req);
    if (!u) {
      accessLog.recordDenied(req, 401, 'api-login-required');
      return res.status(401).json({ error: 'Login required', auth: true });
    }
    const ban = isBannedNow(u.account);
    if (ban) {
      accessLog.recordDenied(req, 403, 'banned');
      return res.status(403).json({
        error: ban.permanent ? `Banned: ${ban.reason}` : `Timed out until ${new Date(ban.until).toLocaleString()}`,
        banned: true,
      });
    }
    req.wpUser = { username: u.username, role: u.account.role };
    return next();
  }

  // everything else that's not public: let it pass (static files, misc)
  next();
};

/* the main gate for "/" — no session = login page, banned = banned page,
   logged in = the app UI with the user injected */
function gateHome(sendIndex) {
  return (req, res) => {
    if (req.query.wpoverlay === '1') {
      const html0 = fs.readFileSync(sendIndex(), 'utf8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(html0);
    }
    const u = userFromReq(req);
    if (!u) return serveFile(res, 'login.html');
    const ban = isBannedNow(u.account);
    if (ban) {
      const htmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const reasonText = ban.permanent ? ban.reason : `${ban.reason} — until ${new Date(ban.until).toLocaleString()}`;
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'banned.html'), 'utf8')
        .replace('__REASON__', htmlEsc(reasonText));
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

module.exports = {
  router, gate, gateHome, userFromReq, peekUser, isBannedNow, users, sessions,
  saveUsers, saveSessions, COOKIE, hashPassword, verifyPassword, setUsageEmitter,
};