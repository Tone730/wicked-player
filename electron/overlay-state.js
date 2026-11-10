'use strict';
/* Wicked Player - overlay state helpers (pure, no Electron imports).
   Shared by electron/main.js and tested by electron/test/overlay-state.test.js */

function clampBounds(bounds, displays) {
  if (!bounds || !Array.isArray(displays) || displays.length === 0) {
    return bounds || null;
  }
  const b = {
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: Math.max(200, Math.round(Number(bounds.width) || 440)),
    height: Math.max(100, Math.round(Number(bounds.height) || 190)),
  };
  let best = displays[0];
  let bestArea = -1;
  for (const d of displays) {
    const wa = d.workArea;
    const ox = Math.max(0, Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x));
    const oy = Math.max(0, Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y));
    const area = ox * oy;
    if (area > bestArea) { bestArea = area; best = d; }
  }
  const wa = best.workArea;
  const x = Math.min(Math.max(b.x, wa.x), Math.max(wa.x, wa.x + wa.width - b.width));
  const y = Math.min(Math.max(b.y, wa.y), Math.max(wa.y, wa.y + wa.height - b.height));
  return { x: x, y: y, width: b.width, height: b.height };
}

function sanitizePlayerState(raw) {
  const base = { ok: false, playing: false, title: '', artist: '', art: null, pos: 0, dur: 0, hasTrack: false };
  if (!raw || typeof raw !== 'object') return base;
  const num = function (v) { return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0; };
  const title = String(raw.title || '').slice(0, 200);
  const artist = String(raw.artist || '').slice(0, 200);
  const dur = num(raw.dur);
  const pos = Math.min(num(raw.pos), dur || num(raw.pos));
  const art = (typeof raw.art === 'string' && /^https?:\/\//.test(raw.art)) ? raw.art : null;
  const hasTrack = !!(title && title.toLowerCase() !== 'nothing playing');
  return { ok: true, playing: !!raw.playing, title: title, artist: artist, art: art, pos: pos, dur: dur, hasTrack: hasTrack };
}

function formatTime(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

const OVERLAY_DEFAULTS = Object.freeze({
  bounds: null,
  skin: 'winamp',
  compact: false,
  volume: 0.8,
  showOnStart: false,
});

function mergeOverlaySettings(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  const vol = Number(s.volume);
  return {
    bounds: (s.bounds && typeof s.bounds.x === 'number') ? {
      x: s.bounds.x, y: s.bounds.y,
      width: Number(s.bounds.width) || 440,
      height: Number(s.bounds.height) || 190,
    } : null,
    skin: (typeof s.skin === 'string') ? s.skin : OVERLAY_DEFAULTS.skin,
    compact: !!s.compact,
    volume: isFinite(vol) ? Math.min(1, Math.max(0, vol)) : OVERLAY_DEFAULTS.volume,
    showOnStart: !!s.showOnStart,
  };
}

module.exports = { clampBounds: clampBounds, sanitizePlayerState: sanitizePlayerState, formatTime: formatTime, OVERLAY_DEFAULTS: OVERLAY_DEFAULTS, mergeOverlaySettings: mergeOverlaySettings };