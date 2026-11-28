/* Community module: profiles, friends, chat, presence, listen-together */
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const auth = require('./auth');
const { atomicWriteJSON } = require('./lib/store');

const COMM_FILE = path.join(__dirname, 'data', 'community.json');
const STATS_FILE = path.join(__dirname, 'data', 'listen-stats.json');
const LIB_FILE = path.join(__dirname, 'data', 'library.json');

/* ---------- shared validation helpers ---------- */
const NAME_RE = /^[a-zA-Z0-9_.-]{2,20}$/;
const RESERVED_NAMES = new Set(['admin', 'administrator', 'root', 'system', 'me', 'general', 'undefined', 'null']);
const knownAccount = (n) => NAME_RE.test(String(n || '')) && !RESERVED_NAMES.has(String(n)) && !!auth.users[String(n)];
function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}
function safeColor(v, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fallback;
}
function safeHttpUrl(v) {
  const s = cleanText(v, 300);
  if (!s) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? s : null;
  } catch { return null; }
}
function safeMediaUrl(v) {
  const s = cleanText(v, 300);
  if (!s) return null;
  if (s.startsWith('/media/') && !/\.[./\\]/.test(s.slice(7))) return s;
  return safeHttpUrl(s);
}
function safeDiscordWebhook(v) {
  const s = safeHttpUrl(v);
  return s && /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(s) ? s : null;
}
function premiumNow(p) {
  if (!p) return false;
  if (p.premiumUntil) return Date.now() < p.premiumUntil;
  return !!p.premium;
}

const THEME_PRESETS = ['midnight', 'aurora', 'sunset', 'mono', 'violet-dusk', 'mint', 'cyber', 'custom'];
const AVATAR_FRAMES = ['none', 'neon', 'gold', 'prism', 'ember', 'galaxy', 'holo', 'orbit', 'cyber'];
const PROFILE_EFFECTS = ['none', 'glow', 'shimmer', 'rainbow', 'aurora', 'sparkles', 'particles', 'waves', 'nebula'];
const TAG_STYLES = ['solid', 'outline', 'glass', 'gradient'];
const TAG_ANIMS = ['none', 'pulse', 'glow', 'rainbow', 'marquee', 'bounce', 'flicker', 'typewriter', 'glitch', 'wave'];
const BANNER_ANIMS = ['none', 'pan', 'parallax', 'pulse', 'float', 'zoom'];
const BACKGROUND_ANIMS = ['none', 'pan', 'zoom', 'float', 'drift'];
const CARD_SHAPES = ['rounded', 'squircle', 'sharp'];
const EARNED_BADGES = ['early', 'listener', 'superlistener', 'helper', 'founder', 'dj', 'premium', 'verified'];
function pickEnum(v, allowed, fallback) {
  return allowed.includes(String(v || '')) ? String(v) : fallback;
}
function safeNumber(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function xmlEscape(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function discordClientId() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'discord-app.json'), 'utf8'));
    if (cfg.clientId) return String(cfg.clientId);
  } catch {}
  return '';
}
/* Build a CustomRP-compatible .crp preset (the XML shape its .NET Preset
   struct serializes to) from a user's profile. Element order, booleans and
   the unset date match CustomRP's serializer so the file imports cleanly. */
function presetImage(v) {
  // Presets are imported by the desktop app on another machine: only absolute
  // http(s) URLs survive, local /media/ paths cannot be resolved there.
  const s = safeHttpUrl(v);
  return s || 'wicked';
}
function buildCrpPreset(name, p) {
  const prem = premiumNow(p);
  const disp = cleanText(p.displayName, 40) || name;
  const tag = prem ? cleanText(p.tagText, 24) : '';
  const details = cleanText(p.presenceDetails, 120) ||
    ('Listening on Wicked Player' + (tag ? '  · ' + tag : ''));
  const state = cleanText(p.presenceState, 120) ||
    [cleanText(p.status, 80), 'Wicked Player'].filter(Boolean).join('  · ').slice(0, 120);
  const large = presetImage(p.presenceImage) === 'wicked'
    ? (presetImage(p.banner) === 'wicked' ? presetImage(p.avatar) : presetImage(p.banner))
    : presetImage(p.presenceImage);
  const small = (prem && presetImage(p.avatar) !== 'wicked') ? presetImage(p.avatar) : 'wicked';
  const profileUrl = 'https://wickedplayer.dev/u/' + encodeURIComponent(name);
  const invite = safeHttpUrl(p.discordInvite) || 'https://discord.gg/WqAGkmnmmA';
  const detailUrl = safeHttpUrl(p.presenceButtonUrl) || '';
  const b1 = cleanText(p.presenceButtonLabel, 28) || 'View profile';
  const vals = {
    ID: cleanText(p.discordClientId, 24) || discordClientId(),
    Type: 2, Display: 0,
    Name: 'Wicked Player',
    Details: details, DetailsURL: detailUrl,
    State: state, StateURL: '',
    PartySize: 0, PartyMax: 0,
    Timestamps: 0,
    CustomTimestamp: '0001-01-01T00:00:00',
    CustomTimestampEndEnabled: 'false',
    CustomTimestampEnd: '0001-01-01T00:00:00',
    LargeKey: large, LargeText: (disp + '  · Wicked Player').slice(0, 120), LargeURL: '',
    SmallKey: small, SmallText: 'Wicked Player', SmallURL: '',
    Button1Text: b1, Button1URL: profileUrl,
    Button2Text: 'Join Discord', Button2URL: invite,
  };
  const el = (k) => `  <${k}>${xmlEscape(vals[k])}</${k}>`;
  const order = ['ID', 'Type', 'Display', 'Name', 'Details', 'DetailsURL', 'State', 'StateURL',
    'PartySize', 'PartyMax', 'Timestamps', 'CustomTimestamp', 'CustomTimestampEndEnabled',
    'CustomTimestampEnd', 'LargeKey', 'LargeText', 'LargeURL', 'SmallKey', 'SmallText', 'SmallURL',
    'Button1Text', 'Button1URL', 'Button2Text', 'Button2URL'];
  return '<?xml version="1.0"?>\n' +
    '<Preset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
    order.map(el).join('\n') + '\n</Preset>\n';
}
function listenSummary(name) {
  try {
    const st = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))[name] || { total: 0, months: {} };
    const lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
    const mine = (lib.history || []).filter((h) => (h.user || 'guest') === name);
    const artists = {};
    let topSong = null;
    const songs = {};
    for (const h of mine) {
      const a = (h.artist || 'Unknown').split(',')[0].trim() || 'Unknown';
      artists[a] = (artists[a] || 0) + 1;
      const k = h.name + '|' + h.artist;
      songs[k] = songs[k] || { name: h.name, artist: h.artist, count: 0 };
      songs[k].count++;
    }
    const topArtist = Object.entries(artists).sort((a, b) => b[1] - a[1])[0];
    const song = Object.values(songs).sort((a, b) => b.count - a.count)[0];
    return {
      minutes: Math.round((st.total || 0) / 60),
      plays: mine.length,
      topArtist: topArtist ? { name: topArtist[0], count: topArtist[1] } : null,
      topSong: song || null,
    };
  } catch {
    return { minutes: 0, plays: 0, topArtist: null, topSong: null };
  }
}
function badgesFor(name, p) {
  const out = [];
  const s = listenSummary(name);
  const acc = auth.users[name] || {};
  if (acc.createdAt && acc.createdAt < Date.UTC(2026, 1, 1)) out.push('early');
  if (s.minutes >= 60) out.push('listener');
  if (s.minutes >= 600) out.push('superlistener');
  if (premiumNow(p)) out.push('premium');
  if (p.verified) out.push('verified');
  for (const b of (p.badges || [])) if (EARNED_BADGES.includes(b) && !out.includes(b)) out.push(b);
  return out.slice(0, 8);
}

/* The community document holds the premium profiles and the redemption
   receipts, so a failed read must never be turned into an empty document:
   writing that fallback would erase every profile and redemption history.
   A broken document raises instead, and the routes answer 503. */
class CommunityStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommunityStoreError';
    this.status = 503;
  }
}
let lastLoadOk = true;
function load() {
  let raw;
  try {
    raw = fs.readFileSync(COMM_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') { lastLoadOk = true; return { profiles: {}, chat: { general: [] } }; }
    lastLoadOk = false;
    throw new CommunityStoreError(`The community store could not be read: ${error && error.message || error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    lastLoadOk = false;
    throw new CommunityStoreError(`The community store is not valid JSON: ${error && error.message || error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    lastLoadOk = false;
    throw new CommunityStoreError('The community store has an invalid shape.');
  }
  if (parsed.profiles !== undefined && parsed.profiles !== null
    && (typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles))) {
    lastLoadOk = false;
    throw new CommunityStoreError('The community store has an invalid profile map.');
  }
  lastLoadOk = true;
  return parsed;
}
function save(d) {
  /* While the store cannot be read, nothing is written: the broken document
     stays on disk so it can be repaired instead of being overwritten. */
  if (!lastLoadOk) {
    process.stderr.write('[community] refusing to write while the store is unreadable\n');
    return false;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)
    || (d.profiles !== undefined && d.profiles !== null
      && (typeof d.profiles !== 'object' || Array.isArray(d.profiles)))) {
    process.stderr.write('[community] refusing to write an invalid community document\n');
    return false;
  }
  try { atomicWriteJSON(COMM_FILE, d); return true; }
  catch (e) { process.stderr.write(`[community] profile save failed: ${e && e.message || e}\n`); return false; }
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

function publicProfile(name, p, viewer) {
  const mine = viewer === name;
  const prem = premiumNow(p);
  const showStats = p.showStats !== false;
  const pv = p.privacy && typeof p.privacy === 'object' ? p.privacy : {};
  const show = (k) => pv[k] !== false;
  // Premium private profiles reveal only a minimal card to other viewers.
  if (prem && pv.private && !mine) {
    return {
      name,
      displayName: cleanText(p.displayName, 40),
      avatar: safeMediaUrl(p.avatar),
      accent: safeColor(p.accent, '#8b5cf6'),
      bio: '', verified: !!p.verified, premium: true, private: true,
      badges: show('showBadges') ? badgesFor(name, p) : [],
    };
  }
  return {
    name,
    bio: cleanText(p.bio, 200),
    accent: safeColor(p.accent, '#8b5cf6'),
    accent2: safeColor(p.accent2, '#ec4899'),
    themeAccent: prem ? safeColor(p.themeAccent, '#b57cff') : '',
    avatar: safeMediaUrl(p.avatar),
    banner: safeMediaUrl(p.banner),
    displayName: cleanText(p.displayName, 40),
    status: cleanText(p.status, 80),
    favGenre: cleanText(p.favGenre, 40),
    pronouns: cleanText(p.pronouns, 24),
    location: cleanText(p.location, 40),
    favDecade: cleanText(p.favDecade, 10),
    links: show('showLinks') && p.links && typeof p.links === 'object' ? p.links : {},
    bannerStyle: p.bannerStyle || '',
    bannerFrom: safeColor(p.bannerFrom, '#8b5cf6'),
    bannerTo: safeColor(p.bannerTo, '#1d1f21'),
    bannerAnimated: prem && !!p.bannerAnimated,
    /* new profile canvas: static image/GIF backgrounds (free), motion (premium) */
    profileBg: safeMediaUrl(p.profileBg),
    profileBgFit: pickEnum(p.profileBgFit, ['cover', 'contain', 'tile'], 'cover'),
    profileBgAnim: prem ? pickEnum(p.profileBgAnim, BACKGROUND_ANIMS, 'none') : 'none',
    bannerAnim: prem ? pickEnum(p.bannerAnim, BANNER_ANIMS, 'none') : 'none',
    cardShape: prem ? pickEnum(p.cardShape, CARD_SHAPES, 'rounded') : 'rounded',
    /* new tag system: style is free, motion/glow stay premium */
    tagText: prem ? cleanText(p.tagText, 24) : '',
    tagColor: prem ? safeColor(p.tagColor, '#a855f7') : '#a855f7',
    tagGlow: prem && !!p.tagGlow,
    tagAnim: prem ? pickEnum(p.tagAnim, TAG_ANIMS, 'none') : 'none',
    tagStyle: pickEnum(p.tagStyle, TAG_STYLES, 'solid'),
    /* Discord presence auto-config (free) */
    presenceEnabled: p.presenceEnabled !== false,
    presenceDetails: cleanText(p.presenceDetails, 120),
    presenceState: cleanText(p.presenceState, 120),
    presenceImage: safeMediaUrl(p.presenceImage),
    presenceButtonLabel: cleanText(p.presenceButtonLabel, 28),
    presenceButtonUrl: safeHttpUrl(p.presenceButtonUrl) || '',
    discordInvite: safeHttpUrl(p.discordInvite) || '',
    themePreset: pickEnum(p.themePreset, THEME_PRESETS, 'midnight'),
    featuredBadge: prem ? pickEnum(p.featuredBadge, EARNED_BADGES, '') : '',
    playerAccent: prem ? safeColor(p.playerAccent, '#b57cff') : '#b57cff',
    playerBg: prem ? safeColor(p.playerBg, '#0b0912') : '#0b0912',
    playerText: prem ? safeColor(p.playerText, '#f6f2ff') : '#f6f2ff',
    avatarFrame: prem ? pickEnum(p.avatarFrame, AVATAR_FRAMES, 'none') : 'none',
    profileEffect: prem ? pickEnum(p.profileEffect, PROFILE_EFFECTS, 'none') : 'none',
    featuredTrack: prem ? cleanText(p.featuredTrack, 80) : '',
    showStats: showStats,
    stats: showStats || mine ? listenSummary(name) : null,
    badges: show('showBadges') ? badgesFor(name, p) : [],
    verified: !!p.verified,
    premium: prem,
    premiumUntil: p.premiumUntil || null,
    privacy: {
      showBadges: show('showBadges'), showLinks: show('showLinks'), showNp: show('showNp'),
      showFollowers: show('showFollowers'), allowFollow: show('allowFollow'),
      private: prem && !!pv.private,
    },
    followers: show('showFollowers') ? (p.followers || []).length : 0,
    following: show('showFollowers') ? (p.following || []).length : 0,
    np: show('showNp') && p.np && Date.now() - (p.np.at || 0) < 5 * 60 * 1000 ? p.np : null,
    ...(mine ? {
      friends: p.friends || [],
      incoming: p.requests || [],
      outgoing: p.outgoing || [],
      followRequests: (p.followRequests || []).length,
      badgesOwned: EARNED_BADGES,
      themePresets: THEME_PRESETS,
      avatarFrames: AVATAR_FRAMES,
      profileEffects: PROFILE_EFFECTS,
      perks: {
        higherBitrate: prem,
        priorityResolution: prem,
        unlimitedOffline: prem,
        giftPremium: prem,
        largerLimits: prem,
      },
      giftedTo: (p.giftedTo || []).length,
    } : {}),
  };
}

router.get('/api/profiles/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!knownAccount(name)) return res.status(404).json({ error: 'profile not found' });
  const d = load();
  const p = d.profiles[name];
  if (!p) return res.status(404).json({ error: 'profile not found' });
  const viewer = auth.userFromReq(req)?.username || null;
  res.json(publicProfile(name, p, viewer));
});

router.get('/api/profiles', (req, res) => {
  const viewer = auth.userFromReq(req)?.username || null;
  const d = load();
  const out = {};
  for (const [name, p] of Object.entries(d.profiles)) {
    if (!knownAccount(name)) continue; // hide ghost/profile-only names
    out[name] = publicProfile(name, p, viewer);
  }
  res.json(out);
});

const LINK_KEYS = ['discord', 'tiktok', 'instagram', 'twitter', 'youtube', 'spotify', 'twitch', 'soundcloud', 'website'];
function cleanLinks(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const k of LINK_KEYS) {
    const rawv = raw[k];
    if (k === 'discord' && /^\d{17,20}$/.test(String(rawv || '').trim())) {
      clean[k] = 'https://discord.gg/' + String(rawv).trim();
      continue;
    }
    if (k === 'discord' && /^(?:discord\.gg\/|discord\.com\/invite\/)/i.test(String(rawv || '').trim())) {
      clean[k] = 'https://' + String(rawv).trim();
      continue;
    }
    const v = safeHttpUrl(rawv);
    if (v) clean[k] = v.slice(0, 120);
  }
  return clean;
}

router.post('/api/profile', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const ban = auth.isBannedNow(u.account);
  if (ban) return res.status(403).json({ error: 'This account is banned' });

  const name = u.username; // identity comes from the session, never the request body
  const d = load();
  const p = d.profiles[name] = d.profiles[name] || { friends: [], requests: [], outgoing: [] };
  const prem = premiumNow(p);

  if (req.body.bio !== undefined) p.bio = cleanText(req.body.bio, 200);
  if (req.body.accent !== undefined) p.accent = safeColor(req.body.accent, '#8b5cf6');
  if (req.body.accent2 !== undefined) p.accent2 = safeColor(req.body.accent2, '#ec4899');
  if (req.body.themeAccent !== undefined) p.themeAccent = prem ? safeColor(req.body.themeAccent, '#b57cff') : '';
  if (req.body.avatar !== undefined) p.avatar = safeMediaUrl(req.body.avatar);
  if (req.body.banner !== undefined) p.banner = safeMediaUrl(req.body.banner);
  if (req.body.displayName !== undefined) p.displayName = cleanText(req.body.displayName, 40);
  if (req.body.status !== undefined) p.status = cleanText(req.body.status, 80);
  if (req.body.favGenre !== undefined) p.favGenre = cleanText(req.body.favGenre, 40);
  if (req.body.pronouns !== undefined) p.pronouns = cleanText(req.body.pronouns, 24);
  if (req.body.location !== undefined) p.location = cleanText(req.body.location, 40);
  if (req.body.favDecade !== undefined) p.favDecade = cleanText(req.body.favDecade, 10);
  if (req.body.showStats !== undefined) p.showStats = !!req.body.showStats;
  if (req.body.badges !== undefined && Array.isArray(req.body.badges)) {
    p.badges = req.body.badges
      .map((b) => cleanText(b, 24))
      .filter((b) => ['early', 'listener', 'superlistener', 'helper'].includes(b))
      .slice(0, 8);
  }
  if (req.body.themePreset !== undefined) {
    const wanted = pickEnum(req.body.themePreset, THEME_PRESETS, 'midnight');
    p.themePreset = prem || wanted !== 'custom' ? wanted : 'midnight';
  }
  if (req.body.playerAccent !== undefined) p.playerAccent = prem ? safeColor(req.body.playerAccent, '#b57cff') : (p.playerAccent || '');
  if (req.body.playerBg !== undefined) p.playerBg = prem ? safeColor(req.body.playerBg, '#0b0912') : (p.playerBg || '');
  if (req.body.playerText !== undefined) p.playerText = prem ? safeColor(req.body.playerText, '#f6f2ff') : (p.playerText || '');
  if (req.body.avatarFrame !== undefined) p.avatarFrame = prem ? pickEnum(req.body.avatarFrame, AVATAR_FRAMES, 'none') : 'none';
  if (req.body.profileEffect !== undefined) p.profileEffect = prem ? pickEnum(req.body.profileEffect, PROFILE_EFFECTS, 'none') : 'none';
  if (req.body.featuredTrack !== undefined) p.featuredTrack = prem ? cleanText(req.body.featuredTrack, 80) : '';
  if (req.body.featuredBadge !== undefined) p.featuredBadge = prem ? pickEnum(req.body.featuredBadge, EARNED_BADGES, '') : '';
  if (req.body.privacy !== undefined && req.body.privacy && typeof req.body.privacy === 'object') {
    const pv = p.privacy && typeof p.privacy === 'object' ? p.privacy : {};
    for (const k of ['showBadges', 'showLinks', 'showNp', 'showFollowers', 'allowFollow']) {
      if (req.body.privacy[k] !== undefined) pv[k] = !!req.body.privacy[k];
    }
    if (prem && req.body.privacy.private !== undefined) pv.private = !!req.body.privacy.private;
    p.privacy = pv;
  }

  if (req.body.bannerStyle !== undefined) {
    p.bannerStyle = ['gradient', 'animated', 'upload'].includes(req.body.bannerStyle) ? req.body.bannerStyle : '';
  }
  if (req.body.bannerFrom !== undefined) p.bannerFrom = safeColor(req.body.bannerFrom, '#8b5cf6');
  if (req.body.bannerTo !== undefined) p.bannerTo = safeColor(req.body.bannerTo, '#1d1f21');
  if (req.body.bannerAnimated !== undefined) p.bannerAnimated = prem ? !!req.body.bannerAnimated : false;
  /* new profile canvas */
  if (req.body.profileBg !== undefined) p.profileBg = safeMediaUrl(req.body.profileBg);
  if (req.body.profileBgFit !== undefined) p.profileBgFit = pickEnum(req.body.profileBgFit, ['cover', 'contain', 'tile'], 'cover');
  if (req.body.profileBgAnim !== undefined) p.profileBgAnim = prem ? pickEnum(req.body.profileBgAnim, BACKGROUND_ANIMS, 'none') : 'none';
  if (req.body.bannerAnim !== undefined) p.bannerAnim = prem ? pickEnum(req.body.bannerAnim, BANNER_ANIMS, 'none') : 'none';
  if (req.body.cardShape !== undefined) p.cardShape = prem ? pickEnum(req.body.cardShape, CARD_SHAPES, 'rounded') : 'rounded';
  if (req.body.tagStyle !== undefined) p.tagStyle = pickEnum(req.body.tagStyle, TAG_STYLES, 'solid');
  /* free tag text/color become an editable style plate; motion stays premium */
  if (req.body.tagText !== undefined) p.tagText = prem ? cleanText(req.body.tagText, 24) : (p.tagText || '');
  if (req.body.tagColor !== undefined) p.tagColor = prem ? safeColor(req.body.tagColor, '#a855f7') : (p.tagColor || '');
  if (req.body.tagGlow !== undefined) p.tagGlow = prem ? !!req.body.tagGlow : false;
  if (req.body.tagAnim !== undefined) p.tagAnim = prem ? pickEnum(req.body.tagAnim, TAG_ANIMS, 'none') : (p.tagAnim || '');
  /* Discord presence auto-config fields */
  if (req.body.presenceEnabled !== undefined) p.presenceEnabled = !!req.body.presenceEnabled;
  if (req.body.presenceDetails !== undefined) p.presenceDetails = cleanText(req.body.presenceDetails, 120);
  if (req.body.presenceState !== undefined) p.presenceState = cleanText(req.body.presenceState, 120);
  if (req.body.presenceImage !== undefined) p.presenceImage = safeMediaUrl(req.body.presenceImage);
  if (req.body.presenceButtonLabel !== undefined) p.presenceButtonLabel = cleanText(req.body.presenceButtonLabel, 28);
  if (req.body.presenceButtonUrl !== undefined) p.presenceButtonUrl = safeHttpUrl(req.body.presenceButtonUrl) || '';
  if (req.body.discordInvite !== undefined) p.discordInvite = safeHttpUrl(req.body.discordInvite) || '';

  if (req.body.links !== undefined) p.links = cleanLinks(req.body.links);
  if (req.body.discordWebhook !== undefined) p.discordWebhook = safeDiscordWebhook(req.body.discordWebhook);
  p.lastSeen = Date.now();
  save(d);
  res.json({ ok: true, profile: publicProfile(name, p, name) });
});

router.get('/api/premium/status', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const d = load();
  const p = d.profiles[u.username] || {};
  const prem = premiumNow(p);
  res.json({
    premium: prem,
    premiumUntil: p.premiumUntil || null,
    features: {
      themePresets: THEME_PRESETS,
      avatarFrames: AVATAR_FRAMES,
      profileEffects: PROFILE_EFFECTS,
      badges: EARNED_BADGES,
      customAccent: prem,
      playerTheme: prem,
      privateProfile: prem,
      bannerAnimated: prem,
      animatedProfileBg: prem,
      animatedBannerMotion: prem,
      advancedTagAnim: prem,
      cardShape: prem,
      tagText: prem,
      featuredTrack: prem,
      higherBitrate: prem,
      priorityResolution: prem,
      unlimitedOffline: prem,
      giftPremium: prem,
      largerLimits: prem,
      referralCredits: prem,
    },
    perks: {
      higherBitrate: prem,
      priorityResolution: prem,
      unlimitedOffline: prem,
      giftPremium: prem,
      largerLimits: prem,
    },
  });
});

/* ---------- Discord presence auto-config + CustomRP preset export ---------- */
function presenceConfig(name, p) {
  const prem = premiumNow(p);
  const tag = prem ? cleanText(p.tagText, 24) : '';
  const profileUrl = 'https://wickedplayer.dev/u/' + encodeURIComponent(name);
  return {
    enabled: p.presenceEnabled !== false,
    displayName: cleanText(p.displayName, 40) || name,
    tag,
    avatar: safeMediaUrl(p.avatar) || '',
    banner: safeMediaUrl(p.banner) || '',
    details: cleanText(p.presenceDetails, 120) ||
      ('Listening on Wicked Player' + (tag ? '  ·  ' + tag : '')),
    state: cleanText(p.presenceState, 120) ||
      [cleanText(p.status, 80), 'Wicked Player'].filter(Boolean).join('  ·  ').slice(0, 120),
    image: safeHttpUrl(p.presenceImage) || safeHttpUrl(p.banner) || '',
    buttonLabel: cleanText(p.presenceButtonLabel, 28) || 'View profile',
    buttonUrl: safeHttpUrl(p.presenceButtonUrl) || profileUrl,
    invite: safeHttpUrl(p.discordInvite) || 'https://discord.gg/WqAGkmnmmA',
    profileUrl,
    clientId: discordClientId(),
  };
}
function sendCrp(res, name, p) {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="wicked-' + name + '.crp"');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buildCrpPreset(name, p));
}
router.get('/api/presence/config', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  res.json(presenceConfig(u.username, load().profiles[u.username] || {}));
});
router.get('/api/presence/crp', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  sendCrp(res, u.username, load().profiles[u.username] || {});
});
router.get('/api/profiles/:name/crp', (req, res) => {
  const name = String(req.params.name || '');
  if (!knownAccount(name)) return res.status(404).json({ error: 'profile not found' });
  const p = load().profiles[name];
  if (!p) return res.status(404).json({ error: 'profile not found' });
  const viewer = auth.userFromReq(req)?.username || null;
  if (premiumNow(p) && p.privacy && p.privacy.private && viewer !== name) {
    return res.status(403).json({ error: 'private profile' });
  }
  sendCrp(res, name, p);
});

/* ---------- follow / public social graph ---------- */
router.post('/api/follow', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const target = String(req.body?.name || '');
  if (!knownAccount(target) || target === u.username) return res.status(400).json({ error: 'Invalid user' });
  const d = load();
  const mine = d.profiles[u.username] = d.profiles[u.username] || { friends: [], requests: [], outgoing: [] };
  const theirs = d.profiles[target] = d.profiles[target] || { friends: [], requests: [], outgoing: [] };
  mine.following = mine.following || [];
  theirs.followers = theirs.followers || [];
  if (!mine.following.includes(target)) mine.following.push(target);
  if (!theirs.followers.includes(u.username)) theirs.followers.push(u.username);
  save(d);
  res.json({ ok: true, following: true, name: target });
});

router.delete('/api/follow/:name', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const target = String(req.params.name || '');
  const d = load();
  const mine = d.profiles[u.username];
  const theirs = d.profiles[target];
  if (mine?.following) mine.following = mine.following.filter((n) => n !== target);
  if (theirs?.followers) theirs.followers = theirs.followers.filter((n) => n !== u.username);
  save(d);
  res.json({ ok: true, following: false, name: target });
});

router.post('/discord/say', async (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const d = load();
  const { track, message } = req.body;
  const name = u.username;
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
if (!process.env.ADMIN_KEY) throw new Error('ADMIN_KEY must be set in .env');
const ADMIN_KEY_COMM = process.env.ADMIN_KEY;
const adminAuthComm = (req, res, next) => {
  const a = Buffer.from(String(req.get('X-ADMIN-KEY') || ''));
  const b = Buffer.from(ADMIN_KEY_COMM);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ msg: 'no' });
  next();
};
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
    premium: premiumNow(p),
    premiumUntil: p.premiumUntil || null,
    banned: !!bans[name],
    banReason: bans[name]?.reason || '',
    lastSeen: p.lastSeen || 0,
    status: p.status || '',
    displayName: p.displayName || '',
    verified: !!p.verified,
    badges: badgesFor(name, p),
    themePreset: p.themePreset || 'midnight',
  }));
  res.json(out);
});
router.post('/api/admin/premium', adminAuthComm, (req, res) => {
  const d = load();
  const { name, on } = req.body;
  if (!name || !d.profiles[name]) return res.status(404).json({ error: 'unknown user' });
  d.profiles[name].premium = !!on;
  if (!on) d.profiles[name].premiumUntil = null;
  save(d);
  secLog('premium', 'admin', name + ' -> ' + (on ? 'GRANTED' : 'REVOKED'));
  res.json({ ok: true, name, premium: !!on });
});
router.post('/api/admin/verified', adminAuthComm, (req, res) => {
  const d = load();
  const name = String(req.body.name || '');
  if (!d.profiles[name]) return res.status(404).json({ error: 'unknown user' });
  d.profiles[name].verified = !!req.body.on;
  save(d);
  secLog('verified', 'admin', name + ' -> ' + (req.body.on ? 'ON' : 'OFF'));
  res.json({ ok: true, name, verified: !!req.body.on });
});
router.post('/api/admin/badge', adminAuthComm, (req, res) => {
  const d = load();
  const name = String(req.body.name || '');
  const badge = String(req.body.badge || '');
  if (!d.profiles[name]) return res.status(404).json({ error: 'unknown user' });
  if (!EARNED_BADGES.includes(badge)) return res.status(400).json({ error: 'unknown badge' });
  const p = d.profiles[name];
  p.badges = p.badges || [];
  const i = p.badges.indexOf(badge);
  if (req.body.remove) { if (i >= 0) p.badges.splice(i, 1); }
  else if (i < 0) p.badges.push(badge);
  save(d);
  secLog('badge', 'admin', name + ' ' + (req.body.remove ? '-' : '+') + badge);
  res.json({ ok: true, badges: p.badges });
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
function hashPass(name, pass) {
  return crypto.createHash('sha256').update('wp:' + name + ':' + pass).digest('hex');
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function verifyProfilePass(name, p, pass) {
  if (!p || !pass) return false;
  if (p.salt && p.passHash) return auth.verifyPassword(pass, p.salt, p.passHash);
  if (p.passHash && hashPass(name, pass) === p.passHash) {
    const h = auth.hashPassword(pass);
    p.salt = h.salt; p.passHash = h.hash; // migrate legacy hash
    return true;
  }
  return false;
}

router.post('/api/auth', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Login required', auth: true });
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });
  if (name !== u.username) return res.status(403).json({ error: 'Sign in with the matching account first' });
  if (isBanned(name)) return res.status(403).json({ error: 'This account is banned' });
  const d = load();
  const p = d.profiles[name] = d.profiles[name] || { friends: [], requests: [], outgoing: [] };
  if (!p.passHash) {
    const h = auth.hashPassword(password);
    p.salt = h.salt; p.passHash = h.hash; // first claim of this profile password
  } else if (!verifyProfilePass(name, p, password)) {
    return res.status(401).json({ error: 'Wrong password for this name' });
  }
  const tok = newToken();
  const toks = Array.isArray(p.authTokens)
    ? p.authTokens.filter((t) => typeof t === 'string')
    : (typeof p.authToken === 'string' ? [p.authToken] : []);
  toks.push(tok);
  p.authTokens = toks.slice(-5);
  delete p.authToken;
  p.lastSeen = Date.now();
  save(d);
  res.json({ ok: true, token: tok, name, premium: premiumNow(p) });
});
/* A corrupt community document is reported as unavailable instead of being
   replaced by an empty store. */
router.use((error, _req, res, next) => {
  if (error instanceof CommunityStoreError) {
    process.stderr.write(`[community] store unavailable: ${error.message}\n`);
    return res.status(503).json({ error: 'Community data is unavailable right now.' });
  }
  return next(error);
});
/* ---------- Socket layer ---------- */
function attach(io) {
  let d;
  try {
    d = load();
  } catch (error) {
    /* The socket layer still starts so the admin can reach the panel, but no
       write happens while the store is unreadable. */
    process.stderr.write(`[community] socket layer started without a readable store: ${error && error.message || error}\n`);
    d = { profiles: {} };
  }
  const online = new Map(); // socket.id -> profile snapshot
  const rooms = new Map();  // room -> { host, members:Set<sid>, track, playing, epoch, position }

  const me = (s) => online.get(s.id);
  const snapshot = () => [...online.entries()].map(([sid, p]) => ({ sid, ...p }));

  /* Every socket must belong to a real logged-in session. Identity always
     comes from the cookie — never from a client-supplied profile name. */
  io.use((socket, next) => {
    try {
      const u = auth.userFromReq({ headers: socket.handshake.headers || {} });
      if (!u) return next(new Error('unauthorized'));
      const ban = auth.isBannedNow(u.account);
      if (ban) return next(new Error('banned'));
      socket.data.user = u;
      next();
    } catch { next(new Error('unauthorized')); }
  });

  io.on('connection', (socket) => {
    socket.join('general');
    /* Alerts and live-usage pushes go only to admin sessions. */
    if (socket.data.user?.account?.role === 'admin') socket.join('admins');
    // refresh the session on every socket event so online status stays accurate
    socket.use((_packet, next) => {
      try { auth.userFromReq({ headers: socket.handshake.headers || {} }); } catch {}
      next();
    });

    socket.on('hello', (profile = {}) => {
      const name = socket.data.user?.username;
      if (!name) return;
      if (isBanned(name) || auth.isBannedNow(socket.data.user.account)) {
        const reason = readBans()[name]?.reason || 'You are banned';
        socket.emit('banned', { reason });
        socket.disconnect(true);
        return;
      }
      const saved = d.profiles[name] || { friends: [], requests: [], outgoing: [] };
      const p = {
        sid: socket.id,
        name,
        bio: cleanText(profile.bio ?? saved.bio, 200),
        accent: safeColor(profile.accent ?? saved.accent, '#8b5cf6'),
        avatar: safeMediaUrl(profile.avatar) || safeMediaUrl(saved.avatar) || null,
        banner: safeMediaUrl(profile.banner) || safeMediaUrl(saved.banner) || null,
        premium: premiumNow(saved), // server-computed only
        nowplaying: saved.np && Date.now() - (saved.np.at || 0) < 5 * 60 * 1000
          ? { name: saved.np.title, artist: saved.np.artist } : null,
      };
      p.lastSeen = Date.now();
      d.profiles[name] = saved;
      saved.lastSeen = p.lastSeen;
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
      const key = '#' + entry[0];
      socket.join(key);
      cb?.({ room: key, name: entry[0], owner: entry[1].owner });
    });

    socket.on('room:info', ({ room }, cb) => {
      d.chatRooms = d.chatRooms || {};
      const clean = String(room || '').replace(/^#+/, '');
      const meta = d.chatRooms[clean];
      cb?.({ name: clean, owner: meta?.owner || null, invite: meta?.invite || null });
    });

    const PATCH_KEYS = ['bio', 'accent', 'avatar', 'banner', 'displayName', 'status', 'favGenre', 'links'];
    socket.on('profile:update', (patch = {}) => {
      const p = me(socket);
      if (!p || !patch || typeof patch !== 'object') return;
      const s = d.profiles[p.name] = d.profiles[p.name] || { friends: [], requests: [], outgoing: [] };
      for (const k of PATCH_KEYS) {
        if (!(k in patch)) continue;
        if (k === 'bio') { s.bio = cleanText(patch.bio, 200); p.bio = s.bio; }
        else if (k === 'accent') { s.accent = safeColor(patch.accent, '#8b5cf6'); p.accent = s.accent; }
        else if (k === 'avatar') { s.avatar = safeMediaUrl(patch.avatar); p.avatar = s.avatar; }
        else if (k === 'banner') { s.banner = safeMediaUrl(patch.banner); p.banner = s.banner; }
        else if (k === 'links') { s.links = cleanLinks(patch.links); p.links = s.links; }
        else { s[k] = cleanText(patch[k], 80); p[k] = s[k]; }
      }
      p.premium = premiumNow(s); // never trust claimed premium
      save(d);
      io.emit('community', snapshot());
    });

    socket.on('np', ({ track }) => {
      const p = me(socket);
      if (!p) return;
      p.nowplaying = track ? {
        id: track.id, name: cleanText(track.name, 120), artist: cleanText(track.artist, 120),
        art: safeMediaUrl(track.art), stream_url: null, duration_ms: Number(track.duration_ms) || 0, accent: p.accent,
      } : null;
      const s = d.profiles[p.name] = d.profiles[p.name] || { friends: [], requests: [], outgoing: [] };
      s.np = p.nowplaying ? { title: p.nowplaying.name, artist: p.nowplaying.artist, playing: true, at: Date.now() } : null;
      save(d);
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
      if (to && (!knownAccount(to) || to === p.name)) return;
      const conv = to ? dmKey(p.name, to) : (room ? String(room).replace(/[^a-zA-Z0-9_#-]/g, '').slice(0, 40) || 'general' : 'general');
      if (!to && conv !== 'general' && !socket.rooms.has(conv)) return;
      const msg = { from: p.name, text: cleanText(text, 500), at: Date.now(), avatar: p.avatar, accent: p.accent };
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
        io.to(conv).emit('chat:new', { conv, msg });
      }
    });

    /* queue a track for everyone in a listen room */
    socket.on('sr:room', ({ room, track }) => {
      const p2 = me(socket);
      if (!p2 || !room || !track || !socket.rooms.has(String(room))) return;
      io.to(room).emit('sr:new', { from: p2.name, track });
    });

    socket.on('chat:get', ({ conv }, cb) => {
      const p = me(socket);
      if (!p || !conv) return cb?.({ conv, messages: [] });
      if (String(conv).startsWith('dm:')) {
        const parts = String(conv).slice(3).split('|');
        if (parts.length !== 2 || !parts.includes(p.name)) return cb?.({ conv, messages: [] });
      } else if (conv !== 'general' && !socket.rooms.has(String(conv))) {
        return cb?.({ conv, messages: [] });
      }
      const dd = load();
      cb?.({ conv, messages: dd.chat[conv] || [] });
    });

    /* friends */
    socket.on('friend:ask', ({ name }) => {
      const p = me(socket);
      if (!p || !knownAccount(name) || name === p.name) return;
      const dd = load();
      const target = dd.profiles[name] = dd.profiles[name] || { friends: [], requests: [], outgoing: [] };
      const mine = dd.profiles[p.name] = dd.profiles[p.name] || { friends: [], requests: [], outgoing: [] };
      if ((target.friends || []).includes(p.name) || (mine.friends || []).includes(name)) return;
      target.requests = target.requests || [];
      if (!target.requests.includes(p.name)) target.requests.push(p.name);
      mine.outgoing = mine.outgoing || [];
      if (!mine.outgoing.includes(name)) mine.outgoing.push(name);
      save(dd);
      for (const [sid, q] of online) if (q.name === name) io.to(sid).emit('friend:incoming', { from: p.name });
      io.emit('community', snapshot());
    });

    socket.on('friend:accept', ({ name }) => {
      const p = me(socket);
      if (!p || !knownAccount(name)) return;
      const dd = load();
      const mine = dd.profiles[p.name] = dd.profiles[p.name] || { friends: [], requests: [], outgoing: [] };
      if (!(mine.requests || []).includes(name)) return; // require a real incoming request
      mine.requests = (mine.requests || []).filter((x) => x !== name);
      mine.outgoing = (mine.outgoing || []).filter((x) => x !== name);
      mine.friends = mine.friends || [];
      if (!mine.friends.includes(name)) mine.friends.push(name);

      const theirs = dd.profiles[name] = dd.profiles[name] || { friends: [], requests: [], outgoing: [] };
      theirs.requests = (theirs.requests || []).filter((x) => x !== p.name);
      theirs.outgoing = (theirs.outgoing || []).filter((x) => x !== p.name);
      theirs.friends = theirs.friends || [];
      if (!theirs.friends.includes(p.name)) theirs.friends.push(p.name);
      save(dd);
      for (const [sid, q] of online) {
        if (q.name === name || q.name === p.name) io.to(sid).emit('friend:update', { name: p.name, action: 'accepted' });
      }
      io.emit('community', snapshot());
    });

    socket.on('friend:decline', ({ name }) => {
      const p = me(socket);
      if (!p) return;
      const dd = load();
      const mine = dd.profiles[p.name];
      if (mine) {
        mine.requests = (mine.requests || []).filter((x) => x !== name);
        mine.outgoing = (mine.outgoing || []).filter((x) => x !== name);
        save(dd);
      }
      for (const [sid, q] of online) {
        if (q.name === name || q.name === p.name) io.to(sid).emit('friend:update', { name: p.name, action: 'declined' });
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

module.exports = { router, attach, load, save, buildCrpPreset, presenceConfig };
