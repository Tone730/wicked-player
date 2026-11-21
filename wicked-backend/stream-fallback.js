'use strict';
/* Auto-healing fallbacks for stream resolution.
   Triggered only after the primary yt-dlp resolver fails (bot-check, no result,
   no audio format). Tries privacy frontends for a full-length stream, then an
   optional short-preview source, and finally asks for a WireGuard peer rotation
   on repeated bot-checks. Every activation raises an alert. */
const axios = require('axios');
const { execFile } = require('child_process');
const alerts = require('./alerts');

const PIPED = String(process.env.FALLBACK_PIPED_INSTANCES ||
  'https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de,https://pipedapi.reallyaweso.me,https://pipedapi.leptons.xyz')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => /^https:\/\//.test(s));
const ALLOW_PREVIEW = String(process.env.ALLOW_PREVIEW_FALLBACK || '1') === '1';
const ROTATE_ENABLED = String(process.env.AUTO_ROTATE_PEER || '1') === '1';
const ROTATE_SCRIPT = process.env.PEER_ROTATE_SCRIPT || '/usr/local/bin/wicked-peer-rotate.sh';
const BOT_WINDOW_MS = 15 * 60 * 1000;
const BOT_THRESHOLD = 3;
const ROTATE_COOLDOWN_MS = 10 * 60 * 1000;

let botFailures = [];
let rotating = false;
let lastRotate = 0;

function shape(o) {
  return {
    title: o.title,
    duration: o.duration,
    audio_url: o.audio_url,
    proxied_url: `/audio?u=${encodeURIComponent(o.audio_url)}`,
    bitrate: o.bitrate || null,
    ext: o.ext || 'm4a',
    video_id: o.video_id || null,
    source: o.source,
    ...(o.preview ? { preview: true } : {}),
  };
}

/* Try public Piped (Invidious-compatible) instances for a full-length stream. */
async function pipedResolve(query) {
  for (const base of PIPED) {
    try {
      const s = await axios.get(`${base}/search`, {
        params: { q: query, filter: 'videos' }, timeout: 6500,
      });
      const list = Array.isArray(s.data) ? s.data : [];
      const v = list.find((x) => x && x.url && (x.url.includes('watch?v=') || x.url.includes('/watch/')));
      if (!v) continue;
      let id = '';
      try {
        const u = new URL(v.url, base);
        id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
      } catch { continue; }
      if (!id) continue;
      const st = await axios.get(`${base}/streams/${encodeURIComponent(id)}`, { timeout: 6500 });
      const streams = (st.data && st.data.audioStreams) || [];
      const audio = streams
        .filter((a) => a && a.url && !a.videoOnly)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!audio) continue;
      alerts.record('stream-fallback', 'warn', `Full stream resolved via Piped (${new URL(base).host})`, { query, id });
      return shape({
        title: st.data.title || v.title,
        duration: st.data.duration || v.duration || null,
        audio_url: audio.url,
        bitrate: audio.bitrate,
        ext: /opus/i.test(audio.format || '') ? 'webm' : 'm4a',
        video_id: id,
        source: 'piped',
      });
    } catch (e) {
      // try next instance
    }
  }
  return null;
}

/* Last-resort 30s previews from Deezer/iTunes. Better than hard failure. */
async function previewResolve(query) {
  if (!ALLOW_PREVIEW) return null;
  try {
    const r = await axios.get('https://api.deezer.com/search', {
      params: { q: query, limit: 5 }, timeout: 6500,
    });
    const t = ((r.data && r.data.data) || []).find((x) => x && x.preview);
    if (t && t.preview) {
      alerts.record('stream-fallback', 'warn', 'Preview fallback used (Deezer, 30s)', { query, track: t.title });
      return shape({
        title: t.title, duration: 30, audio_url: t.preview,
        bitrate: 128, ext: 'mp3', source: 'deezer-preview', preview: true,
      });
    }
  } catch {}
  try {
    const r = await axios.get('https://itunes.apple.com/search', {
      params: { term: query, entity: 'song', limit: 5 }, timeout: 6500,
    });
    const t = ((r.data && r.data.results) || []).find((x) => x && x.previewUrl);
    if (t && t.previewUrl) {
      alerts.record('stream-fallback', 'warn', 'Preview fallback used (iTunes, 30s)', { query, track: t.trackName });
      return shape({
        title: t.trackName, duration: 30, audio_url: t.previewUrl,
        bitrate: 128, ext: 'm4a', source: 'itunes-preview', preview: true,
      });
    }
  } catch {}
  return null;
}

function requestPeerRotation(reason) {
  if (!ROTATE_ENABLED || rotating) return false;
  const now = Date.now();
  if (now - lastRotate < ROTATE_COOLDOWN_MS) return false;
  lastRotate = now;
  rotating = true;
  alerts.record('peer-rotation', 'warn', 'Rotating Mullvad split-tunnel peer after repeated bot-checks', { reason });
  try {
    execFile(ROTATE_SCRIPT, [String(reason || 'botcheck')], { timeout: 150000 }, (err, stdout, stderr) => {
      rotating = false;
      const out = String(stdout || '') + String(stderr || '');
      alerts.record('peer-rotation', err ? 'critical' : 'info',
        err ? `Peer rotation failed: ${String(err.message || err).slice(0, 160)}` : 'Peer rotation completed',
        { output: out.slice(-1200) });
    });
  } catch (e) {
    rotating = false;
    alerts.record('peer-rotation', 'critical', `Peer rotation could not start: ${e.message}`);
  }
  return true;
}

function noteBotFailure(query, reason) {
  const now = Date.now();
  botFailures = botFailures.filter((t) => now - t < BOT_WINDOW_MS);
  botFailures.push(now);
  alerts.record('stream-botcheck', 'warn', 'YouTube bot-check blocked a stream resolution', { query, reason });
  if (botFailures.length >= BOT_THRESHOLD) {
    const count = botFailures.length;
    botFailures = [];
    requestPeerRotation(`${count} bot-checks`);
  }
}

function stats() {
  return {
    pipedInstances: PIPED.length,
    previewAllowed: ALLOW_PREVIEW,
    autoRotate: ROTATE_ENABLED,
    rotating,
    recentBotFailures: botFailures.length,
    lastRotate: lastRotate || null,
  };
}

/* Full chain: privacy frontend -> short preview -> null. */
async function resolve(query, reason) {
  if (/bot|sign in/i.test(String(reason || ''))) noteBotFailure(query, reason);
  const full = await pipedResolve(query);
  if (full) return full;
  const preview = await previewResolve(query);
  return preview;
}

module.exports = { resolve, noteBotFailure, requestPeerRotation, stats };
