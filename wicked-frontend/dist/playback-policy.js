/* Wicked Player playback policy.
   Small browser-global module shared by the compiled player and enhancement
   layer. It keeps media URLs, queue ownership, and resume positions explicit
   so playback code never has to guess which behavior is safe. */
(function (root) {
  'use strict';

  function normalizeAudioUrl(value, origin) {
    try {
      const base = origin || (typeof location !== 'undefined' ? location.origin : 'https://wickedplayer.dev');
      const url = new URL(String(value || ''), base);
      return url.pathname + url.search;
    } catch {
      return String(value || '');
    }
  }

  function resolveMediaSource(data, origin) {
    if (!data || typeof data !== 'object') return '';
    const base = origin || (typeof location !== 'undefined' ? location.origin : 'https://wickedplayer.dev');
    const proxied = String(data.proxied_url || '').trim();
    if (proxied) {
      try {
        const url = new URL(proxied, base);
        const isJsonEndpoint = url.pathname === '/stream' || url.pathname === '/resolve';
        if (!isJsonEndpoint && (url.protocol === 'http:' || url.protocol === 'https:')) {
          return url.toString();
        }
      } catch {}
    }
    const audioUrl = String(data.audio_url || '').trim();
    if (!audioUrl) return '';
    try {
      const url = new URL(audioUrl, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return new URL('/audio?u=' + encodeURIComponent(url.toString()), base).toString();
    } catch {
      return '';
    }
  }

  function normalizeTrack(context) {
    const source = context || {};
    return {
      id: source.currentId ?? source.id ?? null,
      name: String(source.currentName ?? source.name ?? '').trim(),
      artist: String(source.currentArtist ?? source.artist ?? '').trim(),
    };
  }

  function sameTrack(left, right) {
    if (!left || !right) return false;
    const a = normalizeTrack(left);
    const b = normalizeTrack(right);
    if (a.id != null && b.id != null) {
      return String(a.id) === String(b.id);
    }
    const leftName = a.name.toLowerCase();
    const rightName = b.name.toLowerCase();
    const leftArtist = a.artist.toLowerCase();
    const rightArtist = b.artist.toLowerCase();
    return leftName !== '' && leftName === rightName && leftArtist === rightArtist;
  }

  function shouldContinueRadio(context, endedContext) {
    if (!context) return true;
    if (endedContext && !sameTrack(context, endedContext)) return false;

    const repeat = String(context.repeat || 'off');
    if (repeat === 'one' || repeat === 'all') return false;
    if (context.shuffle || context.autoDJ) return false;

    const queueLength = Math.max(0, Number(context.queueLength) || 0);
    if (queueLength > 0) return false;
    return true;
  }

  function clampResumePosition(requested, duration) {
    let position = Number(requested);
    if (!Number.isFinite(position) || position < 0) position = 0;
    const mediaDuration = Number(duration);
    if (Number.isFinite(mediaDuration) && mediaDuration >= 0) {
      position = Math.min(position, mediaDuration);
    }
    return position;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isPauseControl(control, wasPlaying) {
    if (!wasPlaying || !control || control.disabled) return false;
    const className = typeof control.className === 'string'
      ? control.className
      : String(control.getAttribute && control.getAttribute('class') || '');
    if (/(^|\s)(cbtn|ov-play)(\s|$)/.test(className)) return true;
    const label = [
      control.getAttribute && control.getAttribute('title'),
      control.getAttribute && control.getAttribute('aria-label'),
      control.textContent,
    ].filter(Boolean).join(' ');
    return /\bpause\b/i.test(label);
  }

  function isExplicitPauseEvent(event, options = {}) {
    const wasPlaying = options.wasPlaying !== false;
    if (!event || !wasPlaying) return false;
    if (event.type === 'keydown') {
      return event.code === 'Space' && !isEditableTarget(event.target);
    }
    if (event.type !== 'click' && event.type !== 'pointerdown') return false;
    const target = event.target;
    const control = target && target.closest
      ? target.closest('button, [role="button"]')
      : null;
    return isPauseControl(control, wasPlaying);
  }

  function shouldResumeFullStream(options = {}) {
    if (options.explicitlyPaused === true || options.userPaused === true) return false;
    return options.elementPlaying === true || options.appPlaying === true;
  }

  const policy = {
    clampResumePosition,
    isEditableTarget,
    isExplicitPauseEvent,
    isPauseControl,
    normalizeAudioUrl,
    normalizeTrack,
    resolveMediaSource,
    sameTrack,
    shouldContinueRadio,
    shouldResumeFullStream,
  };

  root.wpPlaybackPolicy = policy;
})(typeof window !== 'undefined' ? window : globalThis);
