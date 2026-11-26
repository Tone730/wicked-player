/* Wicked Player notification policy.
   Classifies HTTP failures by endpoint so playback and background telemetry
   errors are never mislabeled as failed saves. */
(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) root.wpNotificationPolicy = policy;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function pathOf(url) {
    try {
      return new URL(String(url || ''), 'https://wickedplayer.dev').pathname;
    } catch {
      return String(url || '').split('?')[0];
    }
  }

  function isPlaybackPath(path) {
    return path === '/stream' || path === '/audio';
  }

  function isSavePath(path) {
    return /^\/api\/profile$/.test(path)
      || /^\/api\/presence\/config$/.test(path)
      || /^\/library\/playlists(?:\/|$)/.test(path)
      || /^\/library\/like$/.test(path)
      || /^\/library\/artist-like$/.test(path)
      || /^\/api\/premium(?:\/|$)/.test(path)
      || /^\/api\/reward(?:\/|$)/.test(path)
      || /^\/api\/referrals(?:\/|$)/.test(path)
      || /^\/auth\/change-password$/.test(path)
      || path === '/upload';
  }

  function classifyResponse(url, method, status) {
    const code = Number(status) || 0;
    const path = pathOf(url);
    const verb = String(method || 'GET').toUpperCase();
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb);

    if (code === 429) {
      const playback = isPlaybackPath(path);
      const retry = verb === 'GET' && path !== '/audio';
      return {
        kind: playback ? 'playback' : 'busy',
        message: playback
          ? (retry ? 'Player is busy — retrying…' : "Couldn't play this track")
          : (retry ? 'Wicked Player is busy — retrying…' : 'Wicked Player is busy — please try again.'),
        notify: true,
        retry,
      };
    }
    if (code < 500) return null;

    if (isPlaybackPath(path)) {
      return {
        kind: 'playback',
        message: "Couldn't play this track",
        notify: false,
        retry: false,
      };
    }
    if (mutation && isSavePath(path)) {
      return {
        kind: 'save',
        message: `Save failed (${code}). Please try again.`,
        notify: true,
        retry: false,
      };
    }
    return {
      kind: 'ignored',
      message: null,
      notify: false,
      retry: false,
    };
  }

  function createNotificationDeduper(windowMs = 5000) {
    const seen = new Map();
    const windowSize = Math.max(0, Number(windowMs) || 0);
    return function shouldNotify(message, now = Date.now()) {
      const key = String(message || '');
      for (const [oldMessage, at] of seen) {
        if (now - at >= windowSize) seen.delete(oldMessage);
      }
      const previous = seen.get(key);
      if (previous != null && now - previous < windowSize) return false;
      seen.set(key, now);
      return true;
    };
  }

  return { classifyResponse, createNotificationDeduper };
});
