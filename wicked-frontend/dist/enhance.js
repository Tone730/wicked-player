/* Wicked Player — enhancement layer v2
   1. Genre cover art
   2. Autoplay continuation (radio-style)
   3. EXTERNAL OVERLAY: compact draggable player that works over games
      with retro skins (Winamp / Xbox 360 / WMP10 / iPod / Alien-head)
   4. Discord Rich Presence push + community fixes
*/
(function () {
  if (window.__wpEnhance) return;
  window.__wpEnhance = true;

  const isDesktop = !!(window.wickedUpdates && window.wickedUpdates.isDesktop);
  const isOverlay = /[?&]wpoverlay=1/.test(location.search);

  /* ============================================================
     OVERLAY MODE — compact skinnable player, draggable everywhere
  ============================================================ */
  if (isOverlay) return; // the overlay IIFE (appended below) handles the overlay window

  /* ---- 0. auth guard: never show "backend asleep" when it's just a logout ---- */
  const _origFetch = window.fetch;

  // stream resolve cache: instant re-play of tracks you already loaded
  const STREAM_KEY = 'wp-stream-cache';
  const streamMem = (() => { try { return JSON.parse(sessionStorage.getItem(STREAM_KEY) || '{}'); } catch { return {}; } })();
  const saveStream = () => { try { sessionStorage.setItem(STREAM_KEY, JSON.stringify(streamMem)); } catch {} };

  // Map the proxied audio URL back to its resolver data (including video_id).
  const streamByAudio = new Map();
  const wpPrefetched = new Set();
  let adjacentTimer = null;
  function rememberStream(key, data, schedule) {
    if (!data || !data.proxied_url) return;
    streamMem[key] = { at: Date.now(), data };
    streamByAudio.set(location.origin + data.proxied_url, data);
    streamByAudio.set(data.proxied_url, data);
    saveStream();
    if (schedule) { try { scheduleAdjacentPrefetch(key); } catch {} }
  }
  for (const k of Object.keys(streamMem)) {
    if (streamMem[k] && streamMem[k].data) rememberStream(k, streamMem[k].data, false);
  }

  function wpNotify(message) {
    try {
      let box = document.getElementById('wp-toast-box');
      if (!box) {
        box = document.createElement('div');
        box.id = 'wp-toast-box';
        box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:340px';
        document.body.appendChild(box);
      }
      const row = document.createElement('div');
      row.textContent = message;
      row.style.cssText = 'background:#25182f;border:1px solid #b57cff;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5)';
      box.appendChild(row);
      setTimeout(() => row.remove(), 5000);
    } catch {}
  }

  window.fetch = function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const sm = /\?q=([^&]+)/.exec(url);
    if (url.includes('/stream?q=') && sm) {
      const key = decodeURIComponent(sm[1]).toLowerCase();
      const hit = streamMem[key];
      if (hit && Date.now() - hit.at < 20 * 60 * 1000) {
        rememberStream(key, hit.data, false);
        return Promise.resolve(new Response(JSON.stringify(hit.data), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return _origFetch.apply(this, args).then((res) => {
        if (res.ok) {
          res.clone().json().then((data) => { rememberStream(key, data); }).catch(() => {});
        }
        return res;
      });
    }
    const inspect = (res) => {
      if (res.status === 401 && !isOverlay) {
        res.clone().json().then((d) => {
          if (d && d.auth === true && d.error === 'Login required' && !document.getElementById('username')) {
            location.href = '/';
          }
        }).catch(() => {});
      }
      return res;
    };
    return _origFetch.apply(this, args).then(async (res) => {
      if (res.status === 429 || res.status >= 500) {
        wpNotify(res.status === 429 ? 'Wicked Player is busy — retrying…' : 'Save failed (' + res.status + '). Please try again.');
        /* A 429 used to be swallowed by callers, so playlists looked like they
           silently failed to save. Retry idempotent GETs once. */
        const method = String((args[1] && args[1].method) || 'GET').toUpperCase();
        if (res.status === 429 && method === 'GET' && !(args[1] && args[1].body)) {
          await new Promise((r) => setTimeout(r, 1500));
          return inspect(await _origFetch.apply(this, args));
        }
      }
      return inspect(res);
    });
  };

  /* ============ 1. GENRE COVER ART ============ */
  const artCache = (() => { try { return JSON.parse(localStorage.getItem('wp-genre-art') || '{}'); } catch { return {}; } })();
  const saveArtCache = () => { try { localStorage.setItem('wp-genre-art', JSON.stringify(artCache)); } catch {} };
  const inflight = {};
  async function getGenreArt(name) {
    if (artCache[name]) return artCache[name];
    if (inflight[name]) return inflight[name];
    inflight[name] = fetch('/genre-art?name=' + encodeURIComponent(name))
      .then((r) => r.json()).then((d) => {
        if (d.art) { artCache[name] = d.art; saveArtCache(); }
        delete inflight[name]; return d.art || null;
      }).catch(() => { delete inflight[name]; return null; });
    return inflight[name];
  }
  function decorateCard(card) {
    if (card.dataset.wpArt === '1' || card.dataset.wpPending === '1') return;
    const label = card.querySelector('b');
    if (!label) return;
    const genre = label.textContent.trim();
    if (!genre) return;
    card.dataset.wpPending = '1';
    getGenreArt(genre).then((art) => {
      card.dataset.wpPending = '0';
      if (!art) return;
      card.dataset.wpArt = '1';
      card.style.backgroundImage =
        `linear-gradient(180deg, rgba(7,6,13,.30) 0%, rgba(7,6,13,.55) 55%, rgba(7,6,13,.88) 100%), url('${art}')`;
      card.style.backgroundSize = 'cover';
      card.style.backgroundPosition = 'center';
      card.style.color = '#fff';
      card.style.textShadow = '0 2px 8px rgba(0,0,0,.8)';
      card.style.borderColor = 'rgba(255,255,255,.18)';
      const emoji = card.querySelector('.g-emoji');
      if (emoji) emoji.style.display = 'none';
    });
  }
  setInterval(() => document.querySelectorAll('.genre-card').forEach(decorateCard), 2000);

  /* ============ 2. AUTOPLAY CONTINUATION ============ */
  const played = new Set();
  try { (JSON.parse(sessionStorage.getItem('wp-played') || '[]')).forEach((x) => played.add(x)); } catch {}
  const markPlayed = (n) => { played.add((n || '').toLowerCase()); try { sessionStorage.setItem('wp-played', JSON.stringify([...played].slice(-60))); } catch {} };
  let lastTrack = null;

  function currentTrackFromUI() {
    const bar = document.querySelector('footer, [class*="foobar"], [class*="bar-center"]');
    const lines = (bar ? bar.innerText || '' : '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 2) return { name: lines[0], artist: lines[1] };
    return null;
  }
  function getAudio() { return document.querySelector('audio'); }
  function rowText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.wp-badge-chip, [class*="badge"], [class*="src-badge"]').forEach((n) => n.remove());
    return (clone.textContent || '').trim();
  }
  function queryOfRow(row) {
    if (!row) return '';
    const titleEl = row.querySelector('.track-title b, b');
    const artistEl = row.querySelector('.track-title small, small');
    const title = rowText(titleEl);
    const artist = rowText(artistEl);
    return [title, artist].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  function prefetchQuery(q) {
    const key = String(q || '').toLowerCase();
    if (!key || wpPrefetched.has(key)) return;
    wpPrefetched.add(key);
    if (wpPrefetched.size > 120) wpPrefetched.delete(wpPrefetched.values().next().value);
    fetch('/stream?q=' + encodeURIComponent(q), { credentials: 'include' }).catch(() => {});
  }
  function scheduleAdjacentPrefetch(key) {
    clearTimeout(adjacentTimer);
    adjacentTimer = setTimeout(() => {
      const rows = [...document.querySelectorAll('.track')];
      if (!rows.length) return;
      let idx = rows.findIndex((r) => r.classList.contains('active'));
      if (idx < 0) idx = rows.findIndex((r) => queryOfRow(r).toLowerCase() === key);
      if (idx < 0) return;
      for (const r of [rows[idx + 2], rows[idx + 1], rows[idx - 1]]) prefetchQuery(queryOfRow(r));
    }, 350);
  }
  function prefetchTrackRow(target) {
    if (!target || !target.closest) return;
    const row = target.closest('.track, [class*="track-row"], [class*="result-row"]');
    if (!row || row.classList.contains('active')) return;
    prefetchQuery(queryOfRow(row));
  }
  ['pointerover', 'focusin'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { prefetchTrackRow(e.target); }, { passive: true });
  });

  function currentStreamForAudio(a) {
    if (!a) return null;
    const src = a.currentSrc || a.src || '';
    if (!src) return null;
    if (streamByAudio.has(src)) return streamByAudio.get(src);
    try {
      const u = new URL(src, location.origin);
      return streamByAudio.get(u.pathname + u.search) || null;
    } catch { return null; }
  }

  function attachAudioHooks() {
    const a = getAudio();
    if (!a || a.__wpHooks) return false;
    a.__wpHooks = true;
    try { a.preload = 'auto'; } catch {}
    a.addEventListener('loadstart', () => { const d = currentStreamForAudio(a); if (d) setVideoTrack(d); });
    a.addEventListener('play', () => {
      const t = currentTrackFromUI(); if (t && t.name) lastTrack = t;
      const d = currentStreamForAudio(a); if (d) setVideoTrack(d);
      scheduleAdjacentPrefetch(d && d.title ? d.title.toLowerCase() : '');
      syncVideoFromAudio(true);
    });
    a.addEventListener('playing', () => syncVideoFromAudio(true));
    a.addEventListener('pause', () => wpVideoPause());
    a.addEventListener('seeking', () => wpVideoSeek(a.currentTime || 0));
    a.addEventListener('timeupdate', () => wpVideoSeek(a.currentTime || 0));
    a.addEventListener('ratechange', () => wpVideoRate(a.playbackRate || 1));
    a.addEventListener('ended', () => wpVideoPause());
    a.addEventListener('ended', onEnded);
    return true;
  }
  new MutationObserver(() => attachAudioHooks()).observe(document.documentElement, { childList: true, subtree: true });
  attachAudioHooks();

  /* ============================================================
     YOUTUBE VIDEO SYNC
     The audio element remains the source of truth. The YouTube iframe is muted
     and follows play/pause/seek/rate changes, like the synced lyrics pane.
  ============================================================ */
  let videoPanelOpen = false;
  let currentVideoId = null;
  let ytCurrentId = null;
  let ytPlayer = null;
  let ytReady = false;
  let ytRequested = false;

  function ensureVideoUI() {
    if (!document.body) return false;
    let style = document.getElementById('wp-video-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wp-video-style';
      style.textContent = `
        .wp-video-panel{position:fixed;right:24px;bottom:88px;width:min(420px,38vw);aspect-ratio:16/9;background:#08080e;border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.65);z-index:9999;display:none;flex-direction:column;overflow:hidden}
        .wp-video-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:rgba(255,255,255,.05);font:600 12px/1.2 Outfit,system-ui,sans-serif;color:#fff}
        .wp-video-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .wp-video-head button{border:0;background:transparent;color:#fff;font-size:14px;cursor:pointer;padding:2px 6px}
        #wpYTPlayer{width:100%;height:100%;flex:1;background:#000}
        #wpVideoNote{padding:5px 10px;font:11px/1.2 Outfit,system-ui,sans-serif;color:rgba(255,255,255,.62);background:rgba(255,255,255,.03)}
        @media(max-width:700px){.wp-video-panel{width:calc(100vw - 24px);right:12px;bottom:80px}}
      `;
      document.head.appendChild(style);
    }
    let panel = document.getElementById('wpVideoPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'wpVideoPanel';
      panel.className = 'wp-video-panel';
      panel.innerHTML = '<div class="wp-video-head"><span id="wpVideoTitle">Video</span><button id="wpVideoClose" title="Close">✕</button></div><div id="wpYTPlayer"></div><div id="wpVideoNote">Synced to the audio · muted</div>';
      document.body.appendChild(panel);
      panel.querySelector('#wpVideoClose').onclick = toggleVideoPanel;
    }
    ensureVideoButton();
    return true;
  }

  function ensureVideoButton() {
    if (document.getElementById('wpVideoBtn')) return;
    const footer = document.querySelector('footer');
    if (!footer) return;
    const btn = document.createElement('button');
    btn.id = 'wpVideoBtn';
    btn.className = 'icon-btn';
    btn.title = 'Video';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm6 3v8l6-4-6-4z"/></svg>';
    btn.onclick = toggleVideoPanel;
    const lyricsBtn = [...document.querySelectorAll('footer button')].find((b) => b.title === 'Lyrics');
    if (lyricsBtn && lyricsBtn.parentNode) lyricsBtn.parentNode.insertBefore(btn, lyricsBtn);
    else footer.appendChild(btn);
  }

  function wireLyricsVideoButton() {
    const ly = document.querySelector('.lyrics');
    if (!ly || ly.querySelector('.wp-video-open')) return;
    const btn = document.createElement('button');
    btn.className = 'lyrics-close wp-video-open';
    btn.title = 'Watch YouTube video';
    btn.textContent = '▶';
    btn.onclick = (e) => { e.stopPropagation(); toggleVideoPanel(); };
    const first = ly.querySelector('.lyrics-close');
    if (first && first.parentNode) first.parentNode.insertBefore(btn, first.nextSibling);
    else ly.prepend(btn);
  }

  function loadYouTubeAPI() {
    if (ytReady && ytPlayer) return;
    if (window.YT && window.YT.Player) { onYouTubeReady(); return; }
    if (ytRequested) return;
    ytRequested = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prev === 'function') prev();
      onYouTubeReady();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.head.appendChild(s);
  }

  function onYouTubeReady() {
    ytReady = true;
    const host = document.getElementById('wpYTPlayer');
    if (!host || ytPlayer || !window.YT || !window.YT.Player) return;
    ytPlayer = new window.YT.Player(host, {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, controls: 0, modestbranding: 1, rel: 0, disablekb: 1, enablejsapi: 1, origin: location.origin, iv_load_policy: 3 },
      events: {
        onReady: () => {
          try { ytPlayer.mute(); } catch {}
          if (currentVideoId) applyVideoId(currentVideoId, !!(getAudio() && !getAudio().paused));
        },
        onStateChange: (e) => {
          if (!window.YT) return;
          if (e.data === window.YT.PlayerState.PLAYING) {
            try { ytPlayer.mute(); } catch {}
            const a = getAudio();
            if (a && a.paused) { try { ytPlayer.pauseVideo(); } catch {} }
            else if (a) wpVideoSeek(a.currentTime || 0);
          }
          if (e.data === window.YT.PlayerState.ENDED) {
            const a = getAudio();
            if (a && !a.paused) { try { ytPlayer.seekTo(0, true); ytPlayer.playVideo(); } catch {} }
          }
        }
      }
    });
  }

  function setVideoTrack(data) {
    const id = (data && data.video_id) || null;
    const t = document.getElementById('wpVideoTitle');
    if (t) t.textContent = id ? 'Video · ' + ((data && data.title) || 'YouTube') : 'Video';
    const note = document.getElementById('wpVideoNote');
    if (note) note.textContent = id ? 'Synced to the audio · muted' : 'No YouTube video linked to this track.';
    if (id === currentVideoId) return;
    currentVideoId = id;
    ytCurrentId = null;
    if (!id) { try { if (ytPlayer) ytPlayer.stopVideo(); } catch {} return; }
    if (videoPanelOpen) {
      ensureVideoUI();
      loadYouTubeAPI();
      const a = getAudio();
      if (ytReady && ytPlayer) applyVideoId(id, !!(a && !a.paused));
    }
  }

  function applyVideoId(id, autoplay) {
    if (!ytPlayer || !id) return;
    const a = getAudio();
    const start = Math.max(0, (a && a.currentTime || 0) - 0.2);
    try { ytPlayer.mute(); } catch {}
    if (ytCurrentId !== id) {
      try { ytPlayer.cueVideoById({ videoId: id, startSeconds: start }); } catch {}
      ytCurrentId = id;
    } else wpVideoSeek(start);
    if (autoplay) { try { ytPlayer.playVideo(); } catch {} }
  }
  function wpVideoSeek(t) {
    if (!ytPlayer || !currentVideoId || typeof ytPlayer.getCurrentTime !== 'function') return;
    try { if (Math.abs((ytPlayer.getCurrentTime() || 0) - t) > 1.2) ytPlayer.seekTo(Math.max(0, t), true); } catch {}
  }
  function wpVideoPlay() {
    if (!ytPlayer || !currentVideoId) return;
    try { ytPlayer.mute(); if (ytCurrentId !== currentVideoId) applyVideoId(currentVideoId, true); else ytPlayer.playVideo(); } catch {}
  }
  function wpVideoPause() { if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch {} } }
  function wpVideoRate(r) { if (ytPlayer && ytPlayer.setPlaybackRate) { try { ytPlayer.setPlaybackRate(r); } catch {} } }
  function syncVideoFromAudio(force) {
    const a = getAudio();
    if (!a) return;
    const d = currentStreamForAudio(a);
    if (d) setVideoTrack(d);
    if (!videoPanelOpen || !ytPlayer || !currentVideoId) return;
    if (ytCurrentId !== currentVideoId) applyVideoId(currentVideoId, !a.paused);
    else wpVideoSeek(a.currentTime || 0);
    if (force) { if (a.paused) wpVideoPause(); else wpVideoPlay(); }
  }
  function toggleVideoPanel() {
    ensureVideoUI();
    const panel = document.getElementById('wpVideoPanel');
    if (!panel) return;
    videoPanelOpen = !videoPanelOpen;
    panel.style.display = videoPanelOpen ? 'flex' : 'none';
    const btn = document.getElementById('wpVideoBtn');
    if (btn) btn.classList.toggle('wp-video-on', videoPanelOpen);
    if (!videoPanelOpen) { wpVideoPause(); return; }
    loadYouTubeAPI();
    const a = getAudio();
    const d = currentStreamForAudio(a);
    if (d) setVideoTrack(d);
    if (currentVideoId && ytReady && ytPlayer) applyVideoId(currentVideoId, !!(a && !a.paused));
  }

  ensureVideoUI();
  setInterval(() => { ensureVideoButton(); wireLyricsVideoButton(); }, 1500);

  async function onEnded() {
    if (window.__wpContinuing) return;
    await new Promise((r) => setTimeout(r, window.__wpGapless ? 0 : 1200));
    const a = getAudio();
    if (!a) return;
    if (!a.paused || (a.src && a.currentTime > 0 && !a.ended)) return;
    await continueRadio();
  }
  async function continueRadio() {
    if (window.__wpContinuing) return;
    window.__wpContinuing = true;
    try {
      const seed = lastTrack || currentTrackFromUI() || { name: '', artist: '' };
      const artistSeed = (seed.artist || '').split(',')[0].trim();
      if (artistSeed) markPlayed(seed.name || artistSeed);
      const res = await fetch('/api/recommend?artist=' + encodeURIComponent(artistSeed) + '&name=' + encodeURIComponent(seed.name || ''));
      if (!res.ok) throw new Error('recommend failed');
      const tracks = await res.json();
      const fresh = tracks.find((t) => t && t.name && !played.has(t.name.toLowerCase()));
      if (!fresh) throw new Error('nothing fresh');
      markPlayed(fresh.name);
      const input = document.querySelector('input[placeholder*="Search"], .searchbar input');
      const searchBtn = [...document.querySelectorAll('button')].find((b) => /^search$/i.test((b.textContent || '').trim()));
      if (input && searchBtn) {
        input.value = artistSeed || fresh.artist;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        searchBtn.click();
        const clicked = await waitForAndClickResult(fresh);
        if (clicked) return;
      }
      const a = getAudio();
      if (a && fresh.stream_url) {
        a.src = fresh.stream_url.startsWith('http') ? fresh.stream_url : location.origin + fresh.stream_url;
        a.play().catch(() => {});
      }
    } catch {} finally { setTimeout(() => { window.__wpContinuing = false; }, 1500); }
  }
  function waitForAndClickResult(track, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const want = (track.name || '').toLowerCase();
      const iv = setInterval(() => {
        const rows = document.querySelectorAll('[class*="result"] [class*="row"], .r-track, [class*="track-row"], [class*="result-row"]');
        for (const row of rows) {
          const txt = (row.innerText || '').toLowerCase();
          if (want && txt.includes(want) && row.offsetHeight > 20) { clearInterval(iv); row.click(); resolve(true); return; }
        }
        if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
      }, 400);
    });
  }

  /* ---- gift claim: open OUR discord invite, not the old one ---- */
  let wpInvite = null;
  fetch('/api/config/discord-invite').then((r) => r.json()).then((d) => { if (d.invite) wpInvite = d.invite; }).catch(() => {});
  if (isDesktop || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    setInterval(() => {
      try {
        const btn = [...document.querySelectorAll('button')].find((b) => /claim on discord/i.test(b.textContent || ''));
        if (btn && !btn.__wpInviteWired) {
          btn.__wpInviteWired = true;
          btn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            const card = btn.closest('div') && btn.closest('div').parentElement ? btn.closest('div').parentElement : btn.parentElement;
            const codeMatch = card ? (card.innerText.match(/WK-[A-Z2-9]{6}/) || [null])[0] : null;
            if (codeMatch) { try { navigator.clipboard.writeText(codeMatch); } catch {} }
            if (wpInvite) { window.open(wpInvite, '_blank'); }
          }, true);
        }
      } catch {}
    }, 2000);
  }

  /* ---- rewire the app's in-window "Mini player overlay" button to the true overlay ---- */
  if (isDesktop) {
    setInterval(() => {
      try {
        const btn = [...document.querySelectorAll('button')].find((b) => /mini player overlay/i.test(b.title || ''));
        if (btn && !btn.__wpOverlayWired) {
          btn.__wpOverlayWired = true;
          btn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            window.wickedUpdates.winctl('overlay');
          }, true);
        }
      } catch {}
    }, 2000);
  }

  function clickPlayBtn() {
    const btns = [...document.querySelectorAll('button')];
    const prev = btns.find((b) => (b.title || '') === 'Previous');
    if (prev) {
      const mid = prev.nextElementSibling;
      if (mid) { mid.click(); return; }
    }
  }

  /* ============ 5. COMMUNITY: remember-me + online dots + banner fix ============ */
  // auto-identity from auth
  try {
    if (window.__WP_USER && window.__WP_USER.username) {
      localStorage.setItem('wp-me', JSON.stringify({ name: window.__WP_USER.username }));
    }
  } catch {}
  // re-assert identity if the community clears it
  setInterval(() => {
    try {
      const me = JSON.parse(localStorage.getItem('wp-me') || 'null');
      if (!me && window.__WP_USER && window.__WP_USER.username) {
        localStorage.setItem('wp-me', JSON.stringify({ name: window.__WP_USER.username }));
      }
    } catch {}
  }, 5000);

  // online users (public endpoint) → green dots on the People list
  async function paintOnline() {
    try {
      const res = await fetch('/api/online-users');
      const names = await res.json();
      document.querySelectorAll('[class*="profile"], [class*="person"], li').forEach((el) => {
        const name = (el.innerText || '').split('\n')[0].trim();
        if (names.includes(name)) {
          if (!el.querySelector('.wp-online-dot')) {
            const dot = document.createElement('span');
            dot.className = 'wp-online-dot';
            dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;background:#34d399;margin-left:6px;box-shadow:0 0 8px #34d399;';
            el.appendChild(dot);
          }
        }
      });
    } catch {}
  }
  setInterval(paintOnline, 8000);

  // banner: make sure uploaded banner shows on the profile card
  setInterval(() => {
    try {
      const me = JSON.parse(localStorage.getItem('wp-me') || 'null');
      if (!me) return;
      fetch('/api/profiles').then((r) => r.json()).then((profiles) => {
        const mine = profiles[me.name];
        if (mine && mine.banner) {
          const card = [...document.querySelectorAll('[class*="me-card"], [class*="profile-card"]')][0];
          if (card && !card.style.backgroundImage) {
            card.style.backgroundImage = `linear-gradient(180deg, rgba(7,6,13,.2), rgba(7,6,13,.9)), url('${mine.banner}')`;
            card.style.backgroundSize = 'cover';
            card.style.backgroundPosition = 'center top';
          }
        }
      }).catch(() => {});
    } catch {}
  }, 5000);

  /* ---- fix: profile editor taller than viewport gets its own scroll ---- */
  function fixProfileModal() {
    const forms = [...document.querySelectorAll('div,section,form')].filter((d) =>
      d.innerText && d.innerText.includes('Profile banner style') && d.querySelector('input[type=color]'));
    for (const f of forms) {
      let target = f;
      const rootEl = document.getElementById('root');
      while (target.parentElement && target.parentElement !== rootEl && target.parentElement !== document.body) {
        target = target.parentElement;
      }
      if (target.scrollHeight > target.clientHeight + 4 || target.offsetHeight > innerHeight - 40) {
        target.style.maxHeight = 'calc(100vh - 70px)';
        target.style.overflowY = 'auto';
        target.style.overscrollBehavior = 'contain';
      }
    }
  }
  setInterval(fixProfileModal, 2000);

  /* ---- gift / premium code redemption panel ---- */
  window.__wpGiftModal = giftModal;

  /* ============ 6. BACKGROUND CUSTOMIZATION ============ */
  var BG_KEY = "wp-background";
  function applyBackground(cfg) {
    if (!cfg || cfg === "default") { document.body.style.background = ""; var bg = document.querySelector(".bg-art"); if (bg) { bg.style.opacity = ""; bg.style.filter = ""; } return; }
    if (cfg.type === "solid") { document.body.style.background = cfg.value; var bg = document.querySelector(".bg-art"); if (bg) bg.style.opacity = "0"; }
    else if (cfg.type === "image") { document.body.style.background = "#07060d url(\"" + cfg.value + "\") center/cover fixed no-repeat"; var bg = document.querySelector(".bg-art"); if (bg) bg.style.opacity = "0.15"; }
  }
  function loadBackground() { try { var cfg = JSON.parse(localStorage.getItem(BG_KEY) || "null"); if (cfg) applyBackground(cfg); } catch(e) {} }
  loadBackground();
  function bgPanel() {
    var old = document.getElementById("wp-bg-panel"); if (old) { old.remove(); return; }
    var box = document.createElement("div"); box.id = "wp-bg-panel";
    box.style.cssText = "position:fixed;bottom:210px;right:12px;z-index:10001;background:rgba(18,16,31,.97);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px;width:280px;font-family:inherit;box-shadow:0 14px 40px rgba(0,0,0,.5);";
    box.innerHTML = '<div style="font-weight:800;font-size:13px;margin-bottom:12px;color:#d8b4fe">&#127912; Background</div><label style="display:block;font-size:11px;color:rgba(244,242,255,.5);margin-bottom:4px">SOLID COLOR</label><input id="wpBgColor" type="color" value="#07060d" style="width:100%;height:36px;border:none;border-radius:8px;cursor:pointer;margin-bottom:10px"><label style="display:block;font-size:11px;color:rgba(244,242,255,.5);margin-bottom:4px">IMAGE URL</label><input id="wpBgUrl" placeholder="https://... image URL" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:6px"><input id="wpBgFile" type="file" accept="image/*" style="width:100%;font-size:11px;margin-bottom:10px"><div style="display:flex;gap:6px"><button id="wpBgApply" style="flex:1;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;border-radius:8px;padding:8px;font-weight:700;cursor:pointer">Apply</button><button id="wpBgReset" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:8px;padding:8px 14px;cursor:pointer">Reset</button></div><button id="wpBgX" style="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(244,242,255,.5);cursor:pointer;font-size:14px">&#10005;</button>';
    document.body.appendChild(box);
    box.querySelector("#wpBgX").onclick = function() { box.remove(); };
    box.querySelector("#wpBgApply").onclick = function() { var c = box.querySelector("#wpBgColor").value; var u = box.querySelector("#wpBgUrl").value.trim(); var cfg = u ? {type:"image",value:u} : {type:"solid",value:c}; localStorage.setItem(BG_KEY, JSON.stringify(cfg)); applyBackground(cfg); };
    box.querySelector("#wpBgColor").oninput = function() { var cfg = {type:"solid",value:this.value}; localStorage.setItem(BG_KEY, JSON.stringify(cfg)); applyBackground(cfg); };
    box.querySelector("#wpBgFile").onchange = function() { var f = this.files[0]; if (!f) return; var fd = new FormData(); fd.append("file", f); var x = new XMLHttpRequest(); x.open("POST", "/upload"); x.onload = function() { try { var d = JSON.parse(x.responseText); if (d.url) { box.querySelector("#wpBgUrl").value = location.origin + d.url; var cfg = {type:"image",value:location.origin+d.url}; localStorage.setItem(BG_KEY, JSON.stringify(cfg)); applyBackground(cfg); } } catch(e) {} }; x.send(f); };
    box.querySelector("#wpBgReset").onclick = function() { localStorage.removeItem(BG_KEY); applyBackground("default"); box.remove(); };
  }
  /* ============ 6b. PLAYBACK QUALITY: gapless + loudness + persistent sleep ============ */
  var QUALITY_KEY = "wp-quality";
  var SLEEP_KEY = "wp-sleep-until";
  var quality = { gapless: true, normalize: false, level: 0.85 };
  try { var qObj = JSON.parse(localStorage.getItem(QUALITY_KEY) || "null"); if (qObj) quality = Object.assign(quality, qObj); } catch (e) {}
  function applyQuality() {
    window.__wpGapless = !!quality.gapless;
    window.__wpNorm = quality.normalize ? (Number(quality.level) || 0.85) : 1;
    try {
      if (window.__wpMaster) {
        var st = JSON.parse(localStorage.getItem("wp-set") || "{}");
        window.__wpMaster.gain.value = (st.loud ? 1.4 : 1) * window.__wpNorm;
      }
    } catch (e) {}
  }
  applyQuality();
  setInterval(applyQuality, 2000);
  function qualityPanel() {
    var old = document.getElementById("wp-quality-panel"); if (old) { old.remove(); return; }
    var box = document.createElement("div"); box.id = "wp-quality-panel";
    box.style.cssText = "position:fixed;bottom:210px;right:306px;z-index:10001;background:rgba(18,16,31,.97);border:1px solid rgba(168,85,247,.4);border-radius:14px;padding:16px;width:272px;font-family:inherit;box-shadow:0 14px 40px rgba(0,0,0,.5);";
    box.innerHTML = '<div style="font-weight:800;font-size:13px;margin-bottom:12px;color:#d8b4fe">&#127896; Playback quality</div>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px"><input type="checkbox" id="wpQGapless"' + (quality.gapless ? ' checked' : '') + '> Gapless transitions</label>'
      + '<div style="font-size:11px;color:rgba(244,242,255,.45);margin:0 0 12px 24px">Removes the pause between tracks.</div>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px"><input type="checkbox" id="wpQNorm"' + (quality.normalize ? ' checked' : '') + '> Loudness normalization</label>'
      + '<input id="wpQLevel" type="range" min="0.5" max="1.2" step="0.01" value="' + (Number(quality.level) || 0.85) + '" style="width:100%;margin-bottom:4px">'
      + '<div style="font-size:11px;color:rgba(244,242,255,.45);margin-bottom:12px">Target level <span id="wpQLevTxt">' + Math.round((Number(quality.level) || 0.85) * 100) + '%</span></div>'
      + '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px;font-size:11px;color:rgba(244,242,255,.5)">Crossfade and the 15-90 min sleep timer are in Settings. Your sleep timer now survives a reload.</div>'
      + '<button id="wpQX" style="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(244,242,255,.5);cursor:pointer;font-size:14px">&#10005;</button>';
    document.body.appendChild(box);
    box.querySelector("#wpQX").onclick = function() { box.remove(); };
    function save() { localStorage.setItem(QUALITY_KEY, JSON.stringify(quality)); applyQuality(); }
    box.querySelector("#wpQGapless").onchange = function() { quality.gapless = this.checked; save(); };
    box.querySelector("#wpQNorm").onchange = function() { quality.normalize = this.checked; save(); };
    box.querySelector("#wpQLevel").oninput = function() { quality.level = Number(this.value); box.querySelector("#wpQLevTxt").textContent = Math.round(this.value * 100) + "%"; save(); };
  }
  function restoreSleep() {
    var until = 0; try { until = Number(localStorage.getItem(SLEEP_KEY) || 0); } catch (e) {}
    if (!until || until <= Date.now()) { try { localStorage.removeItem(SLEEP_KEY); } catch (e) {} return; }
    var ms = Math.min(until - Date.now(), 6 * 60 * 60 * 1000);
    setTimeout(function () {
      try { var a = document.querySelector("audio"); if (a) a.pause(); } catch (e) {}
      try { localStorage.removeItem(SLEEP_KEY); } catch (e) {}
    }, ms);
  }
  restoreSleep();
  setInterval(function () {
    try {
      var sels = document.querySelectorAll("select");
      for (var i = 0; i < sels.length; i++) {
        var s = sels[i];
        if (s.dataset.wpSleep) continue;
        var opts = s.options || [], isSleep = false;
        for (var j = 0; j < opts.length; j++) { if ((opts[j].textContent || "").indexOf("minute") !== -1) { isSleep = true; break; } }
        if (!isSleep) continue;
        s.dataset.wpSleep = "1";
        s.addEventListener("change", function () {
          var d = Number(this.value);
          try { if (d > 0) localStorage.setItem(SLEEP_KEY, String(Date.now() + d * 60000)); else localStorage.removeItem(SLEEP_KEY); } catch (e) {}
        });
      }
    } catch (e) {}
  }, 1500);
  /* ---- 7. EMPTY STATES ---- */
  setInterval(function() {
    var root = document.getElementById("root"); if (!root) return;
    var text = root.innerText || "";
    if (text.indexOf("Nobody else online yet") !== -1) {
      var els = root.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        if (els[i].children.length === 0 && els[i].textContent.indexOf("Nobody else") !== -1 && els[i].parentElement && !els[i].parentElement.querySelector(".wp-empty-help")) {
          var d = document.createElement("div"); d.className = "wp-empty-help"; d.style.cssText = "font-size:12px;color:rgba(244,242,255,.4);margin-top:8px;line-height:1.5;"; d.innerHTML = "Invite friends to download Wicked Player and create accounts. They will appear here when online."; els[i].parentElement.appendChild(d); break;
        }
      }
    }
  }, 4000);
  /* ---- 8. PREMIUM MESSAGING ---- */
  var PF = { Cinematic: "Cinematic soundboard is Premium. Free packs: Classic, 8-Bit, Percussion.", Horror: "Horror soundboard is Premium.", shimmer: "Shimmer FX is Premium.", rainbow: "Rainbow FX is Premium.", animated: "Animated banners are Premium.", tag: "Custom tags are Premium.", glow: "Tag glow is Premium." };
  var po = new MutationObserver(function() {
    document.querySelectorAll('[class*="hint"], [class*="premium"]').forEach(function(el) {
      if (el.dataset.wpF) return; var t = el.textContent || "";
      if (t.indexOf("is Premium") !== -1 || t.indexOf("Premium feature") !== -1 || t.indexOf("Unlock with") !== -1) {
        el.dataset.wpF = "1";
        var par = el.closest('[class*="preset"], [class*="pack"], [class*="tag"], [class*="banner"]');
        var ctx = par ? (par.textContent || "").slice(0, 80) : ""; var msg = "This feature requires Wicked Premium.";
        for (var k in PF) { if (ctx.indexOf(k) !== -1) { msg = PF[k]; break; } }
        el.textContent = msg; el.style.color = "rgba(216,180,254,.8)";
      }
    });
  });
  po.observe(document.getElementById("root") || document.body || document.documentElement, { childList: true, subtree: true });
  /* ---- 9. SIDEBAR LABELS ---- */
  setInterval(function() {
    document.querySelectorAll(".nav-btn").forEach(function(btn) {
      if (btn.dataset.wpL) return; btn.dataset.wpL = "1";
      var title = btn.title || btn.getAttribute("aria-label") || ""; if (!title) return;
      btn.setAttribute("aria-label", title);
      var span = document.createElement("span"); span.className = "wp-nav-label"; span.textContent = title;
      span.style.cssText = "position:absolute;left:100%;top:50%;transform:translateY(-50%);white-space:nowrap;background:rgba(18,16,31,.95);color:#f4f2ff;padding:5px 12px;border-radius:8px;font-size:12px;pointer-events:none;opacity:0;transition:opacity .15s;z-index:999";
      btn.style.position = "relative"; btn.appendChild(span);
      btn.addEventListener("mouseenter", function() { span.style.opacity = "1"; });
      btn.addEventListener("mouseleave", function() { span.style.opacity = "0"; });
    });
  }, 2000);
  /* ---- 10. LYRICS POLISH ---- */
  setInterval(function() {
    document.querySelectorAll(".lyric-line").forEach(function(l) { l.style.fontSize = "18px"; l.style.lineHeight = "2.2"; });
    var ly = document.querySelector(".lyrics, [class*=\"lyrics\"]"); if (ly) { ly.style.maxHeight = "calc(100vh - 180px)"; ly.style.overflowY = "auto"; }
  }, 1500);
  /* ---- 11. REDUCE GLOW ---- */
  setInterval(function() {
    var bg = document.querySelector(".bg-art"); if (bg && !bg.dataset.wpG) { bg.dataset.wpG = "1"; bg.style.filter = "blur(80px) saturate(1.3) brightness(0.4)"; bg.style.opacity = "0.35"; }
    document.querySelectorAll(".blob").forEach(function(b) { if (!b.dataset.wpG) { b.dataset.wpG = "1"; b.style.opacity = "0.15"; } });
  }, 3000);
  /* ---- 12. GIFT PANEL ---- */
  function giftModal() {
    var old = document.getElementById("wp-gift-panel"); if (old) { old.remove(); return; }
    var box = document.createElement("div"); box.id = "wp-gift-panel";
    box.style.cssText = "position:fixed;bottom:130px;right:12px;z-index:10001;background:rgba(18,16,31,.97);border:1px solid rgba(168,85,247,.4);border-radius:14px;padding:16px;width:290px;font-family:inherit;box-shadow:0 14px 40px rgba(0,0,0,.5)";
    box.style.width = "312px"; box.style.maxHeight = "calc(100vh - 150px)"; box.style.overflowY = "auto";
    box.innerHTML = '<div style="font-weight:800;font-size:13px;margin-bottom:10px;color:#d8b4fe">&#127873; Gifts &amp; Premium</div>'
      + '<div style="font-weight:700;font-size:11px;margin-bottom:5px;color:rgba(244,242,255,.7)">Redeem a code</div><input id="wpGiftCode" placeholder="WK-XXXXXX" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:6px;font-size:13px;text-transform:uppercase"><button id="wpGiftGo" style="width:100%;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;border-radius:9px;padding:9px;font-weight:700;cursor:pointer;font-size:12px;margin-bottom:10px">Redeem</button>'
      + '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px"><div style="font-weight:700;font-size:11px;margin-bottom:5px;color:rgba(244,242,255,.7)">Gift premium to a friend <span style="color:#d8b4fe">(Premium)</span></div><div style="display:flex;gap:6px;margin-bottom:6px"><input id="wpGiftUser" placeholder="username" style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:8px;font-size:12px"><select id="wpGiftDays" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:8px;font-size:12px"><option value="30">30 days</option><option value="7">7 days</option></select></div><button id="wpGiftSend" style="width:100%;background:rgba(168,85,247,.22);border:1px solid rgba(168,85,247,.5);color:#f4f2ff;border-radius:9px;padding:8px;font-weight:600;cursor:pointer;font-size:12px">Send gift</button></div>'
      + '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px;margin-top:10px"><div style="font-weight:700;font-size:11px;margin-bottom:5px;color:rgba(244,242,255,.7)">Referrals</div><div style="font-size:11px;color:rgba(244,242,255,.55);margin-bottom:6px">Your code: <b id="wpRefCode" style="color:#d8b4fe;user-select:all">...</b> &middot; <span id="wpRefCount">0</span> referred &middot; 3 = 7 days Premium</div><div style="display:flex;gap:6px;margin-bottom:6px"><input id="wpRefApply" placeholder="friend WP-CODE" style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:8px;font-size:12px;text-transform:uppercase"><button id="wpRefGo" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:8px;font-weight:600;cursor:pointer;font-size:12px">Apply</button></div></div>'
      + '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px;margin-top:10px"><div style="font-weight:700;font-size:11px;margin-bottom:5px;color:rgba(244,242,255,.7)">No code? Request premium</div><input id="wpGiftMsg" placeholder="tell the admin why" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:6px;font-size:13px"><button id="wpGiftReq" style="width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px;font-weight:600;cursor:pointer;font-size:12px">Send request</button></div>'
      + '<div id="wpGiftOut" style="font-size:11px;margin-top:8px;min-height:16px"></div><button id="wpGiftX" style="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(244,242,255,.5);cursor:pointer;font-size:14px">&#10005;</button>';
    document.body.appendChild(box);
    function say(msg, ok) { var out = box.querySelector("#wpGiftOut"); out.style.color = ok ? "#34d399" : "#fda4af"; out.textContent = msg; }
    box.querySelector("#wpGiftX").onclick = function() { box.remove(); };
    box.querySelector("#wpGiftGo").onclick = function() { fetch("/api/reward/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: box.querySelector("#wpGiftCode").value }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { say("Premium active for " + d.days + " days!", true); } else say(d.error || "Could not redeem"); }).catch(function() { say("Network error"); }); };
    box.querySelector("#wpGiftReq").onclick = function() { fetch("/api/premium/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: (window.__WP_USER || {}).username, message: box.querySelector("#wpGiftMsg").value }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { say("Request sent!", true); } else say(d.error || "Could not send"); }).catch(function() { say("Network error"); }); };
    box.querySelector("#wpGiftSend").onclick = function() { fetch("/api/premium/gift", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: box.querySelector("#wpGiftUser").value, days: Number(box.querySelector("#wpGiftDays").value) }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { say("Gifted " + d.days + " days to " + d.user + "!", true); } else say(d.error || "Could not gift"); }).catch(function() { say("Network error"); }); };
    box.querySelector("#wpRefGo").onclick = function() { fetch("/api/referrals/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: box.querySelector("#wpRefApply").value }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { say("Referral applied!", true); box.querySelector("#wpRefCount").textContent = d.count; } else say(d.error || "Could not apply"); }).catch(function() { say("Network error"); }); };
    fetch("/api/referrals/me", { credentials: "include" }).then(function(r) { return r.json(); }).then(function(d) { if (d && d.code) { box.querySelector("#wpRefCode").textContent = d.code; box.querySelector("#wpRefCount").textContent = d.count; } }).catch(function() {});
  }
  function ensureChipButtons() {
    var chip = document.getElementById("wp-chip");
    if (!chip || !chip.querySelector("button")) return;
    if (!chip.querySelector("#wp-gift")) {
      var gb = document.createElement("button"); gb.id = "wp-gift"; gb.title = "Gifts"; gb.innerHTML = "\u{1F381}";
      gb.onclick = function() { giftModal(); }; chip.insertBefore(gb, chip.querySelector("button"));
    }
    if (!chip.querySelector("#wp-bg-btn")) {
      var bg = document.createElement("button"); bg.id = "wp-bg-btn"; bg.title = "Background"; bg.innerHTML = "\u{1F3A8}";
      bg.onclick = function() { bgPanel(); }; chip.insertBefore(bg, chip.querySelector("button"));
    }
    if (!chip.querySelector("#wp-quality-btn")) {
      var qb = document.createElement("button"); qb.id = "wp-quality-btn"; qb.title = "Playback quality"; qb.innerHTML = "\u{1F3AC}";
      qb.onclick = function() { qualityPanel(); }; chip.insertBefore(qb, chip.querySelector("button"));
    }
    if (!chip.querySelector("#wp-presence-btn")) {
      var pb = document.createElement("button"); pb.id = "wp-presence-btn"; pb.title = "Discord presence & CustomRP preset"; pb.innerHTML = "\u{1F4E1}";
      pb.onclick = function() { window.wpOpenPresenceShare && window.wpOpenPresenceShare(); }; chip.insertBefore(pb, chip.querySelector("button"));
    }
  }
  ensureChipButtons();
  setInterval(ensureChipButtons, 700);
  /* ============ PERF: preconnects ============ */
  for (const href of ['https://itunes.apple.com', 'https://api.deezer.com', 'https://i.scdn.co']) {
    if (!document.querySelector(`link[rel="preconnect"][href="${href}"]`)) {
      const l = document.createElement('link'); l.rel = 'preconnect'; l.href = href;
      document.head.appendChild(l);
    }
  }

  /* ---- 7. EMPTY STATES ---- */
  function improveEmptyStates() {
    var root = document.getElementById("root");
    if (!root) return;
    var text = root.innerText || "";
    if (text.indexOf("Nobody else online yet") !== -1) {
      var els = root.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        if (els[i].children.length === 0 && els[i].textContent.indexOf("Nobody else") !== -1 && els[i].parentElement && !els[i].parentElement.querySelector(".wp-empty-help")) {
          var d = document.createElement("div"); d.className = "wp-empty-help"; d.style.cssText = "font-size:12px;color:rgba(244,242,255,.4);margin-top:8px;line-height:1.5;"; d.innerHTML = "Invite friends to download Wicked Player and create accounts. They will appear here when online."; els[i].parentElement.appendChild(d); break;
        }
      }
    }
  }
  setInterval(improveEmptyStates, 4000);
  /* ---- 10. LYRICS POLISH ---- */
  setInterval(function() {
    document.querySelectorAll(".lyric-line").forEach(function(l) { l.style.fontSize = "18px"; l.style.lineHeight = "2.2"; });
    var ly = document.querySelector(".lyrics, [class*=\"lyrics\"]"); if (ly) { ly.style.maxHeight = "calc(100vh - 180px)"; ly.style.overflowY = "auto"; ly.style.padding = "20px 24px"; }
  }, 1500);
  /* ---- 11. REDUCE GLOW ---- */
  setInterval(function() {
    var bg = document.querySelector(".bg-art"); if (bg && !bg.dataset.wpG) { bg.dataset.wpG = "1"; bg.style.filter = "blur(80px) saturate(1.3) brightness(0.4)"; bg.style.opacity = "0.35"; }
    document.querySelectorAll(".blob").forEach(function(b) { if (!b.dataset.wpG) { b.dataset.wpG = "1"; b.style.opacity = "0.15"; } });
  }, 3000);
  /* ---- 8. PREMIUM MESSAGING ---- */
  var PF = { Cinematic: "Cinematic soundboard is Premium. Free packs: Classic, 8-Bit, Percussion.", Horror: "Horror soundboard is Premium.", shimmer: "Shimmer FX is Premium.", rainbow: "Rainbow FX is Premium.", animated: "Animated banners are Premium.", tag: "Custom tags are Premium.", glow: "Tag glow is Premium." };
  var po = new MutationObserver(function() {
    document.querySelectorAll('[class*="hint"], [class*="premium"]').forEach(function(el) {
      if (el.dataset.wpF) return; var t = el.textContent || "";
      if (t.indexOf("is Premium") !== -1 || t.indexOf("Premium feature") !== -1 || t.indexOf("Unlock with") !== -1) {
        el.dataset.wpF = "1";
        var par = el.closest('[class*="preset"], [class*="pack"], [class*="tag"], [class*="banner"]');
        var ctx = par ? (par.textContent || "").slice(0, 80) : ""; var msg = "This feature requires Wicked Premium.";
        for (var k in PF) { if (ctx.indexOf(k) !== -1) { msg = PF[k]; break; } }
        el.textContent = msg; el.style.color = "rgba(216,180,254,.8)";
      }
    });
  });
  po.observe(document.documentElement, { childList: true, subtree: true });
  /* ---- 9. SIDEBAR LABELS ---- */
  setInterval(function() {
    document.querySelectorAll(".nav-btn").forEach(function(btn) {
      if (btn.dataset.wpL) return; btn.dataset.wpL = "1";
      var title = btn.title || btn.getAttribute("aria-label") || ""; if (!title) return;
      btn.setAttribute("aria-label", title);
      var span = document.createElement("span"); span.className = "wp-nav-label"; span.textContent = title;
      span.style.cssText = "position:absolute;left:100%;top:50%;transform:translateY(-50%);white-space:nowrap;background:rgba(18,16,31,.95);color:#f4f2ff;padding:5px 12px;border-radius:8px;font-size:12px;pointer-events:none;opacity:0;transition:opacity .15s;z-index:999";
      btn.style.position = "relative"; btn.appendChild(span);
      btn.addEventListener("mouseenter", function() { span.style.opacity = "1"; });
      btn.addEventListener("mouseleave", function() { span.style.opacity = "0"; });
    });
  }, 2000);
  /* ---- 10. LYRICS POLISH ---- */
  setInterval(function() {
    document.querySelectorAll(".lyric-line").forEach(function(l) { l.style.fontSize = "18px"; l.style.lineHeight = "2.2"; });
    var ly = document.querySelector(".lyrics, [class*=\"lyrics\"]"); if (ly) { ly.style.maxHeight = "calc(100vh - 180px)"; ly.style.overflowY = "auto"; }
  }, 1500);
  /* ---- 11. REDUCE GLOW ---- */
  setInterval(function() {
    var bg = document.querySelector(".bg-art"); if (bg && !bg.dataset.wpG) { bg.dataset.wpG = "1"; bg.style.filter = "blur(80px) saturate(1.3) brightness(0.4)"; bg.style.opacity = "0.35"; }
    document.querySelectorAll(".blob").forEach(function(b) { if (!b.dataset.wpG) { b.dataset.wpG = "1"; b.style.opacity = "0.15"; } });
  }, 3000);

  /* ---- 12. PROFILE STUDIO + CUSTOM LOOK ---- */
  const WP_PROFILE_STYLE = document.createElement('style');
  WP_PROFILE_STYLE.id = 'wp-profile-style';
  WP_PROFILE_STYLE.textContent = `
    body.wp-frame-neon .avatar, body.wp-frame-neon [class*="avatar"] img { box-shadow:0 0 0 2px #b57cff,0 0 18px rgba(181,124,255,.8)!important; }
    body.wp-frame-gold .avatar, body.wp-frame-gold [class*="avatar"] img { box-shadow:0 0 0 2px #ffd27a,0 0 18px rgba(255,190,90,.7)!important; }
    body.wp-frame-prism .avatar, body.wp-frame-prism [class*="avatar"] img { box-shadow:0 0 0 2px #67e8f9,0 0 0 4px #f0abfc,0 0 20px rgba(103,232,249,.7)!important; }
    body.wp-frame-ember .avatar, body.wp-frame-ember [class*="avatar"] img { box-shadow:0 0 0 2px #fb7185,0 0 20px rgba(251,113,133,.7)!important; }
    body.wp-effect-glow [class*="profile-card"], body.wp-effect-glow [class*="me-card"] { box-shadow:0 0 38px rgba(181,124,255,.28)!important; }
    body.wp-effect-shimmer [class*="profile-card"], body.wp-effect-shimmer [class*="me-card"] { background-image:linear-gradient(110deg,rgba(255,255,255,.02) 30%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.02) 70%);background-size:220% 100%!important;animation:wpShimmer 7s linear infinite; }
    body.wp-effect-rainbow [class*="profile-card"], body.wp-effect-rainbow [class*="me-card"] { background-image:linear-gradient(120deg,#b57cff,#67e8f9,#fb7185,#ffd27a,#b57cff)!important;background-size:300% 300%!important;animation:wpRainbow 9s ease infinite; }
    @keyframes wpShimmer { 0%{background-position:220% 0} 100%{background-position:-100% 0} }
    @keyframes wpRainbow { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
    @media(prefers-reduced-motion:reduce){ body.wp-effect-shimmer [class*="profile-card"], body.wp-effect-shimmer [class*="me-card"], body.wp-effect-rainbow [class*="profile-card"], body.wp-effect-rainbow [class*="me-card"] { animation:none!important; } }
    /* ---- expanded frames / effects / tag plates / profile canvas ---- */
    body.wp-frame-galaxy .avatar, body.wp-frame-galaxy [class*="avatar"] img { box-shadow:0 0 0 2px #818cf8,0 0 0 4px #c084fc,0 0 26px rgba(129,140,248,.8)!important; }
    body.wp-frame-holo .avatar, body.wp-frame-holo [class*="avatar"] img { box-shadow:0 0 0 2px rgba(103,232,249,.9),0 0 24px rgba(103,232,249,.6),inset 0 0 12px rgba(240,171,252,.6)!important; }
    body.wp-frame-orbit .avatar, body.wp-frame-orbit [class*="avatar"] img { box-shadow:0 0 0 2px #f0abfc,0 0 0 6px rgba(240,171,252,.18),0 0 24px rgba(240,171,252,.7)!important;animation:wpOrbit 6s linear infinite; }
    body.wp-frame-cyber .avatar, body.wp-frame-cyber [class*="avatar"] img { box-shadow:0 0 0 2px #22d3ee,0 0 0 4px #0b0912,0 0 0 6px #f0abfc,0 0 26px rgba(34,211,238,.7)!important; }
    @keyframes wpOrbit{0%,100%{filter:hue-rotate(0deg)}50%{filter:hue-rotate(60deg)}}
    body.wp-effect-aurora [class*="profile-card"], body.wp-effect-aurora [class*="me-card"] { background-image:linear-gradient(120deg,rgba(103,232,249,.22),rgba(167,139,250,.22),rgba(52,211,153,.22))!important;background-size:300% 300%!important;animation:wpRainbow 11s ease infinite; }
    body.wp-effect-sparkles [class*="profile-card"]:after, body.wp-effect-sparkles [class*="me-card"]:after { content:"✦  ✧  ✦";position:absolute;top:6px;right:10px;color:rgba(255,210,122,.8);font-size:12px;letter-spacing:5px;animation:wpTwinkle 2.4s ease-in-out infinite;pointer-events:none; }
    body.wp-effect-particles [class*="profile-card"]:after, body.wp-effect-particles [class*="me-card"]:after { content:"·  ·  ·  ·";position:absolute;bottom:8px;right:12px;color:rgba(240,171,252,.85);font-size:18px;letter-spacing:8px;animation:wpTwinkle 3.1s ease-in-out infinite;pointer-events:none; }
    body.wp-effect-waves [class*="profile-card"], body.wp-effect-waves [class*="me-card"] { background-image:repeating-linear-gradient(115deg,rgba(103,232,249,.10) 0 18px,rgba(167,139,250,.10) 18px 36px)!important;background-size:200% 100%!important;animation:wpBannerPan 9s linear infinite; }
    body.wp-effect-nebula [class*="profile-card"], body.wp-effect-nebula [class*="me-card"] { background-image:radial-gradient(circle at 20% 10%,rgba(167,139,250,.35),transparent 45%),radial-gradient(circle at 85% 80%,rgba(244,114,182,.28),transparent 45%)!important;background-size:200% 200%!important;animation:wpRainbow 13s ease infinite; }
    @keyframes wpTwinkle{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
    .wp-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.03em;color:var(--wp-tag-color,#a855f7);border:1px solid currentColor;background:rgba(0,0,0,.25);margin-left:6px;vertical-align:middle}
    .wp-tag.solid{background:var(--wp-tag-color,#a855f7);color:#0b0912;border-color:transparent}
    .wp-tag.outline{background:transparent}
    .wp-tag.glass{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.28);backdrop-filter:blur(6px)}
    .wp-tag.gradient{background:linear-gradient(90deg,var(--wp-tag-color,#a855f7),var(--wp-accent2,#ec4899));color:#0b0912;border-color:transparent}
    .wp-tag.glow{box-shadow:0 0 12px var(--wp-tag-color,#a855f7),0 0 26px rgba(168,85,247,.45)}
    .wp-tag.pulse{animation:wpTagPulse 1.8s ease-in-out infinite}
    .wp-tag.rainbow{background:linear-gradient(90deg,#b57cff,#67e8f9,#fb7185,#ffd27a,#b57cff);background-size:300% 100%;color:#0b0912;border-color:transparent;animation:wpRainbow 5s linear infinite}
    .wp-tag.marquee{max-width:170px;overflow:hidden;white-space:nowrap;display:inline-block;vertical-align:middle;animation:wpMarquee 8s linear infinite}
    .wp-tag.bounce{animation:wpBounce 1.6s ease-in-out infinite}
    .wp-tag.flicker{animation:wpFlicker 2.6s steps(1) infinite}
    .wp-tag.typewriter{overflow:hidden;white-space:nowrap;width:0;border:0;padding-right:0;animation:wpType 3.4s steps(30,end) infinite}
    .wp-tag.glitch{animation:wpGlitch 2.2s steps(2) infinite}
    .wp-tag.wave{animation:wpBounce 2.4s ease-in-out infinite}
    @keyframes wpTagPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:.82}}
    @keyframes wpMarquee{0%,100%{text-indent:0}50%{text-indent:-70px}}
    @keyframes wpBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
    @keyframes wpFlicker{0%,19%,21%,49%,51%,100%{opacity:1}20%,50%{opacity:.35}}
    @keyframes wpType{0%{width:0}45%,80%{width:150px}100%{width:0}}
    @keyframes wpGlitch{0%,92%,100%{transform:translate(0);text-shadow:none}94%{transform:translate(-2px,1px);text-shadow:2px 0 #67e8f9,-2px 0 #fb7185}96%{transform:translate(2px,-1px);text-shadow:-2px 0 #67e8f9,2px 0 #fb7185}}
    /* static image / GIF profile background and motion */
    body.wp-bg-set [class*="profile-card"], body.wp-bg-set [class*="me-card"] { background-image:var(--wp-profile-bg)!important;background-size:var(--wp-bg-fit,cover);background-position:center;background-repeat:var(--wp-bg-repeat,no-repeat); }
    body.wp-bg-tile [class*="profile-card"], body.wp-bg-tile [class*="me-card"] { background-repeat:repeat!important; }
    body.wp-bganim-pan [class*="profile-card"], body.wp-bganim-pan [class*="me-card"] { background-size:200% 100%!important;animation:wpBannerPan 16s linear infinite; }
    body.wp-bganim-zoom [class*="profile-card"], body.wp-bganim-zoom [class*="me-card"] { animation:wpBgZoom 14s ease-in-out infinite; }
    body.wp-bganim-float [class*="profile-card"], body.wp-bganim-float [class*="me-card"] { animation:wpBgFloat 9s ease-in-out infinite; }
    body.wp-bganim-drift [class*="profile-card"], body.wp-bganim-drift [class*="me-card"] { background-size:160% 160%!important;animation:wpRainbow 20s ease infinite; }
    body.wp-banner-pan [class*="banner"], body.wp-banner-pan [class*="profile-card"] [class*="banner"] { background-size:200% 100%!important;animation:wpBannerPan 14s linear infinite; }
    body.wp-banner-parallax [class*="banner"] { background-attachment:fixed!important; }
    body.wp-banner-pulse [class*="banner"] { animation:wpTagPulse 4s ease-in-out infinite; }
    body.wp-banner-float [class*="banner"] { animation:wpBgFloat 7s ease-in-out infinite; }
    body.wp-banner-zoom [class*="banner"] { animation:wpBgZoom 12s ease-in-out infinite; }
    @keyframes wpBannerPan{0%{background-position:0 50%}100%{background-position:200% 50%}}
    @keyframes wpBgZoom{0%,100%{background-size:100% 100%}50%{background-size:135% 135%}}
    @keyframes wpBgFloat{0%,100%{background-position:50% 45%}50%{background-position:50% 60%}}
    body.wp-card-squircle [class*="profile-card"], body.wp-card-squircle [class*="me-card"] { border-radius:28px!important; }
    body.wp-card-sharp [class*="profile-card"], body.wp-card-sharp [class*="me-card"] { border-radius:4px!important; }
    @media(prefers-reduced-motion:reduce){ body[class*="wp-frame-"],body[class*="wp-effect-"],body[class*="wp-bganim-"],body[class*="wp-banner-"],.wp-tag { animation:none!important; } }
    /* compact presence share modal */
    .wp-presence-row{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}
    .wp-presence-row button{flex:0 0 auto}
    .wp-presence-row code{font-size:11px;color:#67e8f9;word-break:break-all}
    .wp-badge-chip{display:inline-block;padding:2px 7px;border-radius:999px;background:rgba(181,124,255,.16);color:#d8b4fe;font-size:10px;font-weight:700;margin-left:5px;letter-spacing:.04em}
    .wp-badge-chip.verified{background:rgba(103,232,249,.16);color:#67e8f9}
    .wp-badge-chip.premium{background:rgba(255,210,122,.16);color:#ffd27a}
    .wp-badge-chip.founder,.wp-badge-chip.dj{background:rgba(251,113,133,.16);color:#fb7185}
    /* Theme presets are applied in JS via CSS variables so premium custom
       accents/backgrounds always take precedence over the preset defaults. */
    .wp-studio{position:fixed;inset:0;z-index:10020;background:rgba(4,3,9,.78);display:flex;align-items:center;justify-content:center;padding:18px}
    .wp-studio-card{width:min(720px,96vw);max-height:92vh;overflow:auto;background:#12101f;border:1px solid rgba(181,124,255,.35);border-radius:18px;padding:22px;box-shadow:0 24px 90px rgba(0,0,0,.7)}
    .wp-studio h2{font-size:18px;margin-bottom:4px}.wp-studio .sub{color:rgba(244,242,255,.55);font-size:12px;margin-bottom:16px}
    .wp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.wp-field{display:flex;flex-direction:column;gap:5px}
    .wp-field label{font-size:11px;color:rgba(244,242,255,.6)}
    .wp-field input,.wp-field select,.wp-field textarea{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#f4f2ff;padding:9px 10px;font:13px/1.4 Outfit,system-ui,sans-serif;outline:none}
    .wp-field textarea{min-height:70px;resize:vertical}.wp-field input:focus,.wp-field select:focus,.wp-field textarea:focus{border-color:#b57cff}
    .wp-locked{opacity:.45}.wp-sec{margin:16px 0 8px;font-size:12px;font-weight:700;color:#d8b4fe;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:6px}
    .wp-studio-actions{display:flex;gap:8px;align-items:center;margin-top:18px}.wp-btn{border:0;border-radius:10px;padding:10px 16px;font:700 13px Outfit,system-ui,sans-serif;cursor:pointer;background:#b57cff;color:#120d1d}
    .wp-btn.ghost{background:rgba(255,255,255,.07);color:#f4f2ff}.wp-btn.amber{background:#ffd27a;color:#241705}
    @media(max-width:620px){.wp-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(WP_PROFILE_STYLE);

  let wpBadgeTimer = null;
  const WP_FRAME_CLASSES = ['none','neon','gold','prism','ember','galaxy','holo','orbit','cyber'].map((x) => 'wp-frame-' + x);
  const WP_EFFECT_CLASSES = ['none','glow','shimmer','rainbow','aurora','sparkles','particles','waves','nebula'].map((x) => 'wp-effect-' + x);
  const WP_BGANIM_CLASSES = ['none','pan','zoom','float','drift'].map((x) => 'wp-bganim-' + x);
  const WP_BANNER_CLASSES = ['none','pan','parallax','pulse','float','zoom'].map((x) => 'wp-banner-' + x);
  const WP_CARD_CLASSES = ['rounded','squircle','sharp'].map((x) => 'wp-card-' + x);
  function applyProfileLook(p) {
    if (!p) return;
    const root = document.documentElement;
    const PRESET = {
      midnight:['#b57cff','#0b0912'], aurora:['#67e8f9','#06141a'], sunset:['#fb923c','#1a0e08'],
      mono:['#d4d4d8','#0a0a0a'], 'violet-dusk':['#a78bfa','#160d26'], mint:['#34d399','#08150f'],
      cyber:['#f0abfc','#0b0620'], custom:['#b57cff','#0b0912'],
    }[p.themePreset || 'midnight'] || ['#b57cff','#0b0912'];
    const accent = (p.premium && (p.themeAccent || p.playerAccent)) || p.accent || PRESET[0];
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--wp-accent', p.accent || accent);
    root.style.setProperty('--wp-accent2', p.accent2 || '#ec4899');
    root.style.setProperty('--wp-bg', (p.premium && p.playerBg) || PRESET[1]);
    root.style.setProperty('--wp-text', p.premium && p.playerText ? p.playerText : '#f6f2ff');
    root.style.setProperty('--wp-tag-color', p.tagColor || '#a855f7');
    if (p.profileBg) {
      root.style.setProperty('--wp-profile-bg', 'url("' + String(p.profileBg).replace(/["<>]/g, '') + '")');
      root.style.setProperty('--wp-bg-fit', p.profileBgFit || 'cover');
      root.style.setProperty('--wp-bg-repeat', p.profileBgFit === 'tile' ? 'repeat' : 'no-repeat');
    } else {
      root.style.removeProperty('--wp-profile-bg');
    }
    document.body.classList.remove(...WP_FRAME_CLASSES, ...WP_EFFECT_CLASSES, ...WP_BGANIM_CLASSES, ...WP_BANNER_CLASSES, ...WP_CARD_CLASSES, 'wp-bg-set', 'wp-bg-tile');
    if (p.avatarFrame && p.avatarFrame !== 'none') document.body.classList.add('wp-frame-' + p.avatarFrame);
    if (p.profileEffect && p.profileEffect !== 'none') document.body.classList.add('wp-effect-' + p.profileEffect);
    if (p.profileBg) document.body.classList.add('wp-bg-set');
    if (p.profileBgFit === 'tile') document.body.classList.add('wp-bg-tile');
    if (p.profileBgAnim && p.profileBgAnim !== 'none') document.body.classList.add('wp-bganim-' + p.profileBgAnim);
    if (p.bannerAnim && p.bannerAnim !== 'none') document.body.classList.add('wp-banner-' + p.bannerAnim);
    if (p.cardShape && p.cardShape !== 'rounded') document.body.classList.add('wp-card-' + p.cardShape);
    document.body.dataset.wpTheme = p.themePreset || 'midnight';
    pushPresenceFromProfile(p);
    // badge + tag chips next to identity text (one timer total, not one per refresh)
    if (wpBadgeTimer) clearInterval(wpBadgeTimer);
    const chips = (p.privacy && p.privacy.showBadges === false) ? [] : (p.badges || []);
    wpBadgeTimer = setInterval(() => {
      document.querySelectorAll('[class*="profile-name"], [class*="me-name"]').forEach((el) => {
        if (!el.dataset.wpBadges) {
          el.dataset.wpBadges = '1';
          for (const b of chips) {
            const c = document.createElement('span');
            c.className = 'wp-badge-chip' + (b === 'verified' ? ' verified' : b === 'premium' ? ' premium' : (b === 'founder' || b === 'dj') ? ' ' + b : '');
            c.textContent = b === 'superlistener' ? '★ superlistener' : b;
            el.appendChild(c);
          }
        }
        if (p.tagText && !el.dataset.wpTag) {
          el.dataset.wpTag = '1';
          const t = document.createElement('span');
          t.className = 'wp-tag ' + (p.tagStyle || 'solid') + ' ' + (p.tagGlow ? 'glow ' : '') + (p.tagAnim || '');
          t.textContent = p.tagText;
          el.appendChild(t);
        }
      });
    }, 4000);
  }

  let myProfile = null;
  async function refreshMyProfile() {
    try {
      const me = (window.__WP_USER || {}).username;
      if (!me) return;
      const all = await (await fetch('/api/profiles', { credentials: 'include' })).json();
      if (all[me]) { myProfile = all[me]; applyProfileLook(myProfile); }
    } catch {}
  }
  refreshMyProfile();
  setInterval(refreshMyProfile, 20000);

  function wpEsc(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  window.wpOpenProfileStudio = async function openProfileStudio() {
    const old = document.getElementById('wp-profile-studio');
    if (old) { old.remove(); return; }
    let p = myProfile;
    try {
      const me = (window.__WP_USER || {}).username;
      const all = await (await fetch('/api/profiles', { credentials: 'include' })).json();
      p = all[me] || p || {};
    } catch { p = p || {}; }
    let prem = !!p.premium;
    try {
      const st = await (await fetch('/api/premium/status', { credentials: 'include' })).json();
      if (st && typeof st.premium === 'boolean') prem = st.premium;
      if (st && st.features) p = { ...p, themePresets: st.features.themePresets, avatarFrames: st.features.avatarFrames, profileEffects: st.features.profileEffects, badgesOwned: st.features.badges };
    } catch {}
    const L = (label, id, val, type, lock) => `<div class="wp-field${lock && !prem ? ' wp-locked' : ''}"><label>${label}${lock && !prem ? ' · premium' : ''}</label><input id="${id}" type="${type || 'text'}" value="${wpEsc(val || '')}" ${lock && !prem ? 'disabled' : ''}></div>`;
    const S = (label, id, val, opts, lock) => `<div class="wp-field${lock && !prem ? ' wp-locked' : ''}"><label>${label}${lock && !prem ? ' · premium' : ''}</label><select id="${id}" ${lock && !prem ? 'disabled' : ''}>${opts.map(o => `<option value="${wpEsc(o)}"${String(val || '') === o ? ' selected' : ''}>${wpEsc(o)}</option>`).join('')}</select></div>`;
    const links = p.links || {};
    const box = document.createElement('div');
    box.id = 'wp-profile-studio';
    box.className = 'wp-studio';
    box.innerHTML = `<div class="wp-studio-card">
      <h2>Profile Studio</h2>
      <div class="sub">Make the profile and player feel like yours. Premium unlocks custom themes, frames, effects, tags and a featured track.</div>
      <div class="wp-sec">Identity</div>
      <div class="wp-grid">
        ${L('Display name','wpPfDisplay',p.displayName)}
        ${L('Status','wpPfStatus',p.status)}
        ${L('Pronouns','wpPfPronouns',p.pronouns)}
        ${L('Location','wpPfLocation',p.location)}
        ${L('Favorite genre','wpPfGenre',p.favGenre)}
        ${L('Favorite decade','wpPfDecade',p.favDecade)}
        <div class="wp-field" style="grid-column:1/-1"><label>Bio</label><textarea id="wpPfBio">${wpEsc(p.bio || '')}</textarea></div>
      </div>
      <div class="wp-sec">Links</div>
      <div class="wp-grid">
        ${L('Discord','wpPfDiscord',links.discord)}
        ${L('TikTok','wpPfTiktok',links.tiktok)}
        ${L('Instagram','wpPfInstagram',links.instagram)}
        ${L('Twitter / X','wpPfTwitter',links.twitter)}
        ${L('YouTube','wpPfYoutube',links.youtube)}
        ${L('Spotify','wpPfSpotify',links.spotify)}
        ${L('Twitch','wpPfTwitch',links.twitch)}
        ${L('SoundCloud','wpPfSoundcloud',links.soundcloud)}
        ${L('Website','wpPfWebsite',links.website)}
      </div>
      <div class="wp-sec">Appearance</div>
      <div class="wp-grid">
        ${L('Accent color','wpPfAccent',p.accent,'color')}
        ${L('Accent 2','wpPfAccent2',p.accent2 || '#ec4899','color')}
        ${L('Avatar URL','wpPfAvatar',p.avatar)}
        ${L('Banner URL','wpPfBanner',p.banner)}
        ${L('Banner from','wpPfBannerFrom',p.bannerFrom,'color')}
        ${L('Banner to','wpPfBannerTo',p.bannerTo,'color')}
        ${S('Theme preset','wpPfTheme',p.themePreset || 'midnight', (prem ? (p.themePresets || ['midnight','aurora','sunset','mono','violet-dusk','mint','cyber','custom']) : ['midnight','aurora','sunset','mono']), prem)}
        ${L('Player accent','wpPfPlayerAccent',p.playerAccent || '#b57cff','color',true)}
        ${L('Player background','wpPfPlayerBg',p.playerBg || '#0b0912','color',true)}
        ${L('Player text','wpPfPlayerText',p.playerText || '#f6f2ff','color',true)}
        ${S('Avatar frame','wpPfFrame',p.avatarFrame || 'none', p.avatarFrames || ['none','neon','gold','prism','ember','galaxy','holo','orbit','cyber'], true)}
        ${S('Profile effect','wpPfEffect',p.profileEffect || 'none', p.profileEffects || ['none','glow','shimmer','rainbow','aurora','sparkles','particles','waves','nebula'], true)}
        ${S('Banner style','wpPfBannerStyle',p.bannerStyle || '', ['','gradient','animated','upload'], false)}
        ${S('Banner motion','wpPfBannerAnim',p.bannerAnim || 'none', ['none','pan','parallax','pulse','float','zoom'], true)}
        ${L('Theme accent','wpPfThemeAccent',p.themeAccent || '#b57cff','color',true)}
        ${S('Featured badge','wpPfFeaturedBadge',p.featuredBadge || '', ['','early','listener','superlistener','helper','founder','dj','premium','verified'], true)}
        ${L('Featured track','wpPfFeatured',p.featuredTrack,'text',true)}
      </div>
      <div class="wp-sec">Profile canvas — backgrounds & banners (pictures or GIFs)</div>
      <div class="wp-grid">
        ${L('Background image / GIF URL','wpPfProfileBg',p.profileBg)}
        ${S('Background fit','wpPfProfileBgFit',p.profileBgFit || 'cover', ['cover','contain','tile'], false)}
        ${S('Background motion','wpPfProfileBgAnim',p.profileBgAnim || 'none', ['none','pan','zoom','float','drift'], true)}
        ${S('Card shape','wpPfCardShape',p.cardShape || 'rounded', ['rounded','squircle','sharp'], true)}
      </div>
      <div class="wp-sec">Custom tag — colored, glowing & animated</div>
      <div class="wp-grid">
        ${L('Tag text','wpPfTag',p.tagText,'text',true)}
        ${L('Tag color','wpPfTagColor',p.tagColor || '#a855f7','color',true)}
        ${S('Tag style','wpPfTagStyle',p.tagStyle || 'solid', ['solid','outline','glass','gradient'], false)}
        ${S('Tag animation','wpPfTagAnim',p.tagAnim || 'none', ['none','pulse','glow','rainbow','marquee','bounce','flicker','typewriter','glitch','wave'], true)}
      </div>
      <div class="wp-sec">Discord presence — auto-config & CustomRP preset</div>
      <div class="wp-grid">
        <div class="wp-field"><label><input type="checkbox" id="wpPfPresenceOn" ${p.presenceEnabled !== false ? 'checked' : ''}> Show my customized presence in Discord (desktop app)</label></div>
        ${L('Presence details','wpPfPresenceDetails',p.presenceDetails)}
        ${L('Presence state','wpPfPresenceState',p.presenceState)}
        ${L('Presence image URL','wpPfPresenceImage',p.presenceImage)}
        ${L('Button label','wpPfPresenceBtn',p.presenceButtonLabel)}
        ${L('Button URL','wpPfPresenceUrl',p.presenceButtonUrl)}
        ${L('Your Discord invite','wpPfDiscordInvite',p.discordInvite)}
      </div>
      <div class="wp-presence-row">
        <button class="wp-btn ghost" type="button" id="wpPfAutoConfig">⚡ Auto-config desktop</button>
        <button class="wp-btn ghost" type="button" id="wpPfPreset">⬇ CustomRP preset</button>
        <button class="wp-btn ghost" type="button" id="wpPfShare">📡 Presence share</button>
      </div>
      <div class="wp-sec">Privacy & stats</div>
      <div class="wp-grid">
        <div class="wp-field"><label><input type="checkbox" id="wpPfStats" ${p.showStats !== false ? 'checked' : ''}> Show listening stats on my profile</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfTagGlow" ${p.tagGlow ? 'checked' : ''} ${prem ? '' : 'disabled'}> Glowing tag ${prem ? '' : '(premium)'}</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPBadges" ${(p.privacy?.showBadges !== false) ? 'checked' : ''}> Show badges</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPLinks" ${(p.privacy?.showLinks !== false) ? 'checked' : ''}> Show links</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPNp" ${(p.privacy?.showNp !== false) ? 'checked' : ''}> Show now playing</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPFollowers" ${(p.privacy?.showFollowers !== false) ? 'checked' : ''}> Show follower counts</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPAllowFollow" ${(p.privacy?.allowFollow !== false) ? 'checked' : ''}> Allow others to follow</label></div>
        <div class="wp-field"><label><input type="checkbox" id="wpPfPPrivate" ${(p.privacy?.private) ? 'checked' : ''} ${prem ? '' : 'disabled'}> Private profile ${prem ? '' : '(premium)'}</label></div>
      </div>
      <div class="wp-studio-actions">
        <button class="wp-btn" id="wpPfSave">Save profile</button>
        <button class="wp-btn ghost" id="wpPfCancel">Cancel</button>
        ${prem ? '' : '<button class="wp-btn amber" id="wpPfPremium">Unlock premium</button>'}
        <span id="wpPfOut" style="font-size:12px;color:rgba(244,242,255,.6)"></span>
      </div>
    </div>`;
    document.body.appendChild(box);
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    box.querySelector('#wpPfCancel').onclick = () => box.remove();
    const premiumBtn = box.querySelector('#wpPfPremium');
    if (premiumBtn) premiumBtn.onclick = () => { box.remove(); document.getElementById('wp-gift')?.click(); };
    box.querySelector('#wpPfAutoConfig').onclick = () => { box.remove(); window.wpAutoConfigPresence && window.wpAutoConfigPresence(); };
    box.querySelector('#wpPfPreset').onclick = () => { window.wpDownloadCrp && window.wpDownloadCrp(); };
    box.querySelector('#wpPfShare').onclick = () => { box.remove(); window.wpOpenPresenceShare && window.wpOpenPresenceShare(); };
    box.querySelector('#wpPfSave').onclick = async () => {
      const v = (id) => box.querySelector('#' + id)?.value;
      const c = (id) => !!box.querySelector('#' + id)?.checked;
      const payload = {
        displayName: v('wpPfDisplay'), status: v('wpPfStatus'), pronouns: v('wpPfPronouns'),
        location: v('wpPfLocation'), favGenre: v('wpPfGenre'), favDecade: v('wpPfDecade'), bio: v('wpPfBio'),
        accent: v('wpPfAccent'), accent2: v('wpPfAccent2'), avatar: v('wpPfAvatar'), banner: v('wpPfBanner'),
        bannerFrom: v('wpPfBannerFrom'), bannerTo: v('wpPfBannerTo'), bannerStyle: v('wpPfBannerStyle'),
        showStats: c('wpPfStats'), tagGlow: c('wpPfTagGlow'),
        profileBg: v('wpPfProfileBg'), profileBgFit: v('wpPfProfileBgFit'),
        tagStyle: v('wpPfTagStyle'),
        presenceEnabled: c('wpPfPresenceOn'),
        presenceDetails: v('wpPfPresenceDetails'), presenceState: v('wpPfPresenceState'),
        presenceImage: v('wpPfPresenceImage'), presenceButtonLabel: v('wpPfPresenceBtn'),
        presenceButtonUrl: v('wpPfPresenceUrl'), discordInvite: v('wpPfDiscordInvite'),
        privacy: {
          showBadges: c('wpPfPBadges'), showLinks: c('wpPfPLinks'), showNp: c('wpPfPNp'),
          showFollowers: c('wpPfPFollowers'), allowFollow: c('wpPfPAllowFollow'),
          ...(prem ? { private: c('wpPfPPrivate') } : {}),
        },
        links: {
          discord: v('wpPfDiscord'), tiktok: v('wpPfTiktok'), instagram: v('wpPfInstagram'),
          twitter: v('wpPfTwitter'), youtube: v('wpPfYoutube'), spotify: v('wpPfSpotify'),
          twitch: v('wpPfTwitch'), soundcloud: v('wpPfSoundcloud'), website: v('wpPfWebsite'),
        },
      };
      if (prem) Object.assign(payload, {
        themePreset: v('wpPfTheme'), themeAccent: v('wpPfThemeAccent'), playerAccent: v('wpPfPlayerAccent'), playerBg: v('wpPfPlayerBg'),
        playerText: v('wpPfPlayerText'), avatarFrame: v('wpPfFrame'), profileEffect: v('wpPfEffect'),
        bannerAnim: v('wpPfBannerAnim'), profileBgAnim: v('wpPfProfileBgAnim'), cardShape: v('wpPfCardShape'),
        tagText: v('wpPfTag'), tagColor: v('wpPfTagColor'), tagAnim: v('wpPfTagAnim'),
        featuredBadge: v('wpPfFeaturedBadge'), featuredTrack: v('wpPfFeatured'),
      });
      const out = box.querySelector('#wpPfOut');
      out.textContent = 'Saving…';
      try {
        const r = await fetch('/api/profile', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'save failed');
        myProfile = d.profile;
        applyProfileLook(d.profile);
        out.style.color = '#5eead4'; out.textContent = 'Saved.';
        setTimeout(() => box.remove(), 700);
      } catch (e) { out.style.color = '#fb7185'; out.textContent = e.message || 'Could not save'; }
    };
  };

  /* ---- 12b. DISCORD PRESENCE AUTO-CONFIG + CUSTOMRP PRESET ---- */
  let lastPresenceCfg = null;
  function cfgFromProfile(p) {
    if (!p) return null;
    const me = (window.__WP_USER || {}).username || '';
    const profileUrl = 'https://wickedplayer.dev/u/' + encodeURIComponent(me);
    return {
      enabled: p.presenceEnabled !== false,
      displayName: p.displayName || me,
      tag: p.tagText || '',
      avatar: p.avatar || '',
      banner: p.banner || '',
      details: p.presenceDetails || ('Listening on Wicked Player' + (p.tagText ? '  ·  ' + p.tagText : '')),
      state: p.presenceState || [p.status, 'Wicked Player'].filter(Boolean).join('  ·  ').slice(0, 120),
      image: p.presenceImage || p.banner || '',
      buttonLabel: p.presenceButtonLabel || 'View profile',
      buttonUrl: p.presenceButtonUrl || profileUrl,
      invite: p.discordInvite || 'https://discord.gg/WqAGkmnmmA',
      profileUrl,
    };
  }
  function pushPresenceFromProfile(p) {
    const cfg = cfgFromProfile(p);
    if (!cfg) return;
    lastPresenceCfg = cfg;
    try {
      if (window.wickedUpdates && typeof window.wickedUpdates.presenceConfig === 'function') {
        window.wickedUpdates.presenceConfig(cfg);
      }
    } catch {}
  }
  window.wpDownloadCrp = function () {
    const a = document.createElement('a');
    a.href = '/api/presence/crp';
    a.download = 'wicked-' + ((window.__WP_USER || {}).username || 'profile') + '.crp';
    document.body.appendChild(a); a.click(); a.remove();
  };
  window.wpAutoConfigPresence = async function () {
    const out = [];
    try {
      const cfg = await (await fetch('/api/presence/config', { credentials: 'include' })).json();
      lastPresenceCfg = cfg;
      if (window.wickedUpdates && typeof window.wickedUpdates.presenceConfig === 'function') {
        window.wickedUpdates.presenceConfig(cfg);
        out.push('Desktop presence auto-configured.');
      } else {
        out.push('Desktop bridge unavailable here — use the CustomRP preset instead.');
      }
    } catch (e) { out.push('Could not load presence config: ' + (e.message || e)); }
    out.push('App ID: ' + ((lastPresenceCfg && lastPresenceCfg.clientId) || 'auto'));
    window.alert(out.join('\n'));
  };
  window.wpOpenPresenceShare = function () {
    const old = document.getElementById('wp-presence-share');
    if (old) { old.remove(); return; }
    const onDesktop = !!(window.wickedUpdates && typeof window.wickedUpdates.presenceConfig === 'function');
    const cfg = lastPresenceCfg || {};
    const box = document.createElement('div');
    box.id = 'wp-presence-share';
    box.className = 'wp-studio';
    box.innerHTML = `<div class="wp-studio-card" style="width:min(560px,96vw)">
      <h2>Share your presence</h2>
      <div class="sub">Your Wicked Player profile powers your Discord activity. One click in the desktop app, or export a preset for CustomRP.</div>
      <div class="wp-sec">Option 1 — Wicked Player desktop (auto)</div>
      <p style="font-size:12px;color:rgba(244,242,255,.7);line-height:1.6">
        Keep the desktop app open with Discord running. Your tag, colors, image and links are applied automatically — no client ID, no setup.
        ${onDesktop ? '<b style="color:#5eead4">Desktop bridge connected.</b>' : '<b style="color:#ffd27a">Open the desktop app to use this option.</b>'}
      </p>
      <div class="wp-presence-row"><button class="wp-btn" id="wpShAuto">⚡ Apply now</button><span id="wpShOut" style="font-size:12px;color:rgba(244,242,255,.6)"></span></div>
      <div class="wp-presence-row"><span id="wpShStatus" style="font-size:12px;color:rgba(244,242,255,.6)">Checking Discord status…</span></div>
      <div class="wp-sec">Option 2 — CustomRP preset (any PC)</div>
      <p style="font-size:12px;color:rgba(244,242,255,.7);line-height:1.6">
        Download a <code>.crp</code> file made from your profile, then import it in CustomRP. Works with the Discord desktop client.
      </p>
      <div class="wp-presence-row"><button class="wp-btn ghost" id="wpShPreset">⬇ Download preset</button><button class="wp-btn ghost" id="wpShStudio">✏ Edit my presence</button></div>
      <div class="wp-sec">Shareable links</div>
      <div class="wp-presence-row"><code>${wpEsc(cfg.profileUrl || 'https://wickedplayer.dev/u/' + encodeURIComponent((window.__WP_USER || {}).username || ''))}</code><button class="wp-btn ghost" id="wpShCopyProfile">Copy</button></div>
      <div class="wp-presence-row"><code>${wpEsc(cfg.invite || 'https://discord.gg/WqAGkmnmmA')}</code><button class="wp-btn ghost" id="wpShCopyInvite">Copy</button></div>
      <div class="wp-studio-actions"><button class="wp-btn ghost" id="wpShClose">Close</button></div>
    </div>`;
    document.body.appendChild(box);
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    box.querySelector('#wpShClose').onclick = () => box.remove();
    const refreshStatus = async () => {
      const s = box.querySelector('#wpShStatus');
      if (!s) return;
      if (!onDesktop || typeof window.wickedUpdates.getPresenceStatus !== 'function') {
        s.style.color = '#ffd27a'; s.textContent = 'Desktop bridge unavailable — use the CustomRP preset on this device.'; return;
      }
      try {
        const st = await window.wickedUpdates.getPresenceStatus();
        if (st && st.enabled === false) {
          s.style.color = '#ffd27a'; s.textContent = 'Presence is turned off in your profile.';
        } else if (st && st.ready) {
          s.style.color = '#5eead4'; s.textContent = '● Connected to Discord — ' + ((st.displayName && st.displayName + ' — ') || '') + 'listening activity is live.';
        } else {
          s.style.color = '#ffd27a'; s.textContent = '○ Discord not connected yet — open Discord and keep the player running.';
        }
      } catch (e) { s.style.color = '#fb7185'; s.textContent = 'Could not read Discord status.'; }
    };
    refreshStatus();
    box.querySelector('#wpShAuto').onclick = async () => {
      const o = box.querySelector('#wpShOut');
      o.textContent = 'Applying…';
      try {
        const c = await (await fetch('/api/presence/config', { credentials: 'include' })).json();
        lastPresenceCfg = c;
        if (window.wickedUpdates && typeof window.wickedUpdates.presenceConfig === 'function') {
          window.wickedUpdates.presenceConfig(c);
          o.style.color = '#5eead4'; o.textContent = 'Applied to desktop.';
        } else {
          o.style.color = '#ffd27a'; o.textContent = 'Open the desktop app to auto-apply.';
        }
        refreshStatus();
      } catch (e) { o.style.color = '#fb7185'; o.textContent = 'Failed: ' + (e.message || e); }
    };
    box.querySelector('#wpShPreset').onclick = () => window.wpDownloadCrp && window.wpDownloadCrp();
    box.querySelector('#wpShStudio').onclick = () => { box.remove(); window.wpOpenProfileStudio && window.wpOpenProfileStudio(); };
    box.querySelector('#wpShCopyProfile').onclick = (e) => { navigator.clipboard?.writeText(cfg.profileUrl || ''); e.target.textContent = 'Copied'; };
    box.querySelector('#wpShCopyInvite').onclick = (e) => { navigator.clipboard?.writeText(cfg.invite || 'https://discord.gg/WqAGkmnmmA'); e.target.textContent = 'Copied'; };
  };
  /* refresh config periodically so the desktop app always has the latest look */
  setInterval(() => { if (myProfile) pushPresenceFromProfile(myProfile); }, 30000);

  /* ---- 13. FASTER SWITCHING + CLIENT TELEMETRY ---- */
  document.addEventListener('pointerover', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('footer button[title="Next"], footer button[title="Previous"]') : null;
    if (!b || b.__wpPre) return;
    b.__wpPre = true;
    const rows = [...document.querySelectorAll('.track')];
    const idx = rows.findIndex((r) => r.classList.contains('active'));
    if (idx < 0) return;
    const isNext = b.title === 'Next';
    prefetchQuery(queryOfRow(rows[isNext ? idx + 1 : idx - 1]));
  }, { passive: true });

  const CLIENT_VERSION = String((window.wickedUpdates && window.wickedUpdates.version) || 'hosted');
  function logAppEvent(kind, extra) {
    const path = kind === 'download' ? '/api/stats/download' : '/api/stats/app-open';
    return fetch(path, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: CLIENT_VERSION, platform: isDesktop ? 'desktop' : 'web', ...(extra || {}) }),
    }).catch(() => {});
  }
  try {
    if (!sessionStorage.getItem('wp-open-logged')) {
      sessionStorage.setItem('wp-open-logged', '1');
      logAppEvent('open', { mode: isDesktop ? 'desktop' : 'web' });
    }
  } catch {}
  setInterval(() => {
    document.querySelectorAll('.update-pill').forEach((b) => {
      if (b.__wpDl) return;
      b.__wpDl = true;
      b.addEventListener('click', () => logAppEvent('download', { source: 'update-pill' }));
    });
    document.querySelectorAll('a[href*=".exe"], a[href*="download"], a[download]').forEach((a) => {
      if (a.__wpDl) return;
      a.__wpDl = true;
      a.addEventListener('click', () => logAppEvent('download', { source: a.href.slice(0, 120) }));
    });
  }, 3000);

  /* Usage heartbeat: visible in the admin panel even with no account.
     The server sets an opaque wpvid cookie and stores only a hash of it. */
  (function usageHeartbeat() {
    let lastSig = '';
    let lastSent = 0;
    function send(kind) {
      if (document.hidden) return;
      const audio = getAudio();
      const track = currentTrackFromUI();
      const playing = !!(audio && !audio.paused);
      lastSent = Date.now();
      lastSig = [track && track.name, track && track.artist, playing].join('|');
      fetch('/api/usage/heartbeat', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, playing, track, platform: isDesktop ? 'desktop' : 'web' }),
      }).catch(() => {});
    }
    send('open');
    setInterval(() => {
      if (document.hidden) return;
      const audio = getAudio();
      const track = currentTrackFromUI();
      const playing = !!(audio && !audio.paused);
      const sig = [track && track.name, track && track.artist, playing].join('|');
      if (sig !== lastSig) send(playing ? 'play' : 'pause');
      else if (Date.now() - lastSent > 45000) send('heartbeat');
    }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) send('resume'); });
  })();
  })();

/* ============================================================
   OVERLAY WINDOW UI - compact, skinnable, keyboard-friendly.
   Runs in its own always-on-top window. State arrives via IPC
   (overlay:state); commands go back (overlay:cmd). The main
   process drives playback, so this stays a thin display.
============================================================ */
(function () {
  if (!/[?&]wpoverlay=1/.test(location.search)) return;

  const wu = window.wickedUpdates;
  if (!wu) return; // only meaningful inside the desktop app

  /* ---------- state ---------- */
  const S = {
    settings: { skin: "winamp", compact: false, volume: 0.8 },
    state: { ok: false, playing: false, title: "", artist: "", art: null, pos: 0, dur: 0, hasTrack: false },
    connected: false,
    lastStateAt: 0,
    videoOn: false,
    el: {},
  };

  /* ---------- DOM ---------- */
  document.title = "Wicked Overlay";
  const css = document.createElement("style");
  css.textContent = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{background:transparent;overflow:hidden;height:100%;font-family:'Outfit','Segoe UI',sans-serif;-webkit-user-select:none;user-select:none}",
    "#ovRoot{height:100%;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:linear-gradient(160deg,rgba(18,16,31,.96),rgba(10,8,20,.97));border:1px solid rgba(168,85,247,.35);box-shadow:0 10px 40px rgba(0,0,0,.55)}",
    "#ovDrag{height:24px;flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:0 8px;-webkit-app-region:drag;background:rgba(255,255,255,.05)}",
    "#ovDrag .ttl{flex:1;font-size:9px;letter-spacing:2px;font-weight:800;color:rgba(244,242,255,.5)}",
    "#ovDrag button,#ovFoot button,#ovBtns button{-webkit-app-region:no-drag}",
    "#ovDrag button{background:none;border:none;color:rgba(244,242,255,.55);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:6px}",
    "#ovDrag button:hover{color:#fff;background:rgba(255,255,255,.1)}",
    "#ovBody{flex:1;display:flex;align-items:center;gap:12px;padding:8px 14px;min-height:0}",
    "#ovArt{width:62px;height:62px;border-radius:10px;flex:0 0 auto;background:rgba(255,255,255,.06) center/cover no-repeat}",
    "#ovMeta{flex:1;min-width:0}",
    "#ovTitle{font-weight:800;font-size:14px;color:#f4f2ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#ovArtist{font-size:12px;color:rgba(244,242,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}",
    "#ovTimes{font-size:10px;color:rgba(244,242,255,.45);margin-top:6px;font-variant-numeric:tabular-nums}",
    "#ovSeek{margin-top:6px;height:6px;border-radius:4px;background:rgba(255,255,255,.12);cursor:pointer;position:relative}",
    "#ovSeekFill{height:100%;border-radius:4px;width:0%;background:linear-gradient(90deg,#a855f7,#ec4899)}",
    "#ovBtns{display:flex;gap:6px;align-items:center;flex:0 0 auto}",
    "#ovBtns button,#ovVol{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:10px;cursor:pointer}",
    "#ovBtns button{width:36px;height:36px;font-size:13px}",
    "#ovBtns .play{width:46px;height:46px;font-size:16px;background:linear-gradient(135deg,#a855f7,#ec4899);border:none}",
    "#ovBtns button:hover{border-color:#a855f7}",
    "#ovBtns button:focus-visible,#ovVol:focus-visible,#ovSeek:focus-visible{outline:2px solid #a855f7;outline-offset:2px}",
    "#ovBtns button:disabled{opacity:.35;cursor:default}",
    "#ovBtns .liked{color:#ec4899;border-color:#ec4899}",
    "#ovVol{width:74px;height:22px;-webkit-appearance:none;appearance:none}",
    "#ovVol::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#a855f7;cursor:pointer}",
    "#ovFoot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:4px 10px 8px}",
    "#ovFoot select{background:rgba(255,255,255,.08);color:#f4f2ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;font-size:11px;padding:3px 6px;font-family:inherit;cursor:pointer}",
    "#ovFoot .sp{flex:1}",
    "#ovFoot .hint{font-size:9px;color:rgba(244,242,255,.35)}",
    "#ovStatus{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:rgba(10,8,20,.92);z-index:5}",
    "#ovStatus .big{font-size:13px;font-weight:700;color:#f4f2ff}",
    "#ovStatus .small{font-size:11px;color:rgba(244,242,255,.5)}",
    "#ovRoot.compact #ovBody{padding:4px 10px;gap:8px}",
    "#ovRoot.compact #ovArt{width:40px;height:40px}",
    "#ovRoot.compact #ovTitle{font-size:12px}",
    "#ovRoot.compact #ovArtist{display:none}",
    "#ovRoot.compact #ovTimes{display:none}",
    "#ovRoot.compact #ovBtns button{width:28px;height:28px;font-size:11px}",
    "#ovRoot.compact #ovBtns .play{width:32px;height:32px}",
    "#ovRoot.compact #ovVol{display:none}",
    ".skin-winamp #ovRoot{background:linear-gradient(180deg,#3a3d36,#141512);border:3px solid #0a0b09;border-radius:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 30px rgba(0,0,0,.6)}",
    ".skin-winamp #ovBody{background:linear-gradient(180deg,#0e1210,#050706);border:2px solid #14150f;box-shadow:inset 0 0 18px rgba(0,0,0,.9);margin:4px 8px;border-radius:3px;position:relative;overflow:hidden}",
    ".skin-winamp #ovBody::after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)}",
    ".skin-winamp #ovTitle{color:#29e07f;font-family:Consolas,monospace;text-shadow:0 0 6px rgba(41,224,127,.7)}",
    ".skin-winamp #ovArtist{color:#8fbf9f;font-family:Consolas,monospace}",
    ".skin-winamp #ovSeekFill{background:#29e07f;box-shadow:0 0 8px rgba(41,224,127,.8)}",
    ".skin-winamp #ovBtns .play{background:linear-gradient(180deg,#29e07f,#0e8f4a);color:#04130a}",
    ".skin-xbox #ovRoot{background:linear-gradient(160deg,#f4f6f8,#eef1f4);border:none;border-radius:20px;box-shadow:0 12px 34px rgba(0,0,0,.45),inset 0 0 0 2px rgba(255,255,255,.7)}",
    ".skin-xbox #ovTitle{color:#23350a}.skin-xbox #ovArtist{color:#5d7a33}",
    ".skin-xbox #ovSeekFill{background:linear-gradient(90deg,#9bf00b,#5faa06)}",
    ".skin-xbox #ovBtns .play{background:radial-gradient(circle at 35% 30%,#c5ff4d,#76c407);color:#fff;border-color:#5faa06}",
    ".skin-wmp #ovRoot{background:linear-gradient(180deg,#1b3a6b,#0a1830);border:2px solid #6d9bd8;border-radius:10px}",
    ".skin-wmp #ovTitle{color:#eaf3ff}.skin-wmp #ovArtist{color:#9dbce6}",
    ".skin-wmp #ovSeekFill{background:linear-gradient(90deg,#ff9a2e,#ffc46e)}",
    ".skin-wmp #ovBtns .play{background:linear-gradient(180deg,#ffb35c,#f07f10);color:#3a1d00}",
    ".skin-ipod #ovRoot{background:linear-gradient(145deg,#f8f9fb,#c3c8d0);border:1px solid #9aa0ab;border-radius:26px}",
    ".skin-ipod #ovBody{background:linear-gradient(180deg,#cdd3da,#b4bac2);border:2px solid #868c97;border-radius:8px;box-shadow:inset 0 2px 6px rgba(0,0,0,.35)}",
    ".skin-ipod #ovTitle{color:#16181d}.skin-ipod #ovArtist{color:#454a53}",
    ".skin-ipod #ovSeekFill{background:#16181d}",
    ".skin-ipod #ovBtns button{background:linear-gradient(180deg,#eef0f3,#c9cdd4);color:#2b2e35;border-color:#868c97}",
    ".skin-ipod #ovBtns .play{background:linear-gradient(180deg,#2b2e35,#0f1114);color:#fff;border-color:#000}",
    ".skin-alien #ovRoot{background:radial-gradient(ellipse at 50% 0%,#062d12,#010d06);border:2px solid #39ff14;border-radius:50px;box-shadow:0 0 26px rgba(57,255,20,.4)}",
    ".skin-alien #ovBody::after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(57,255,20,.06) 0 2px,transparent 2px 4px)}",
    ".skin-alien #ovTitle{color:#39ff14;text-shadow:0 0 10px rgba(57,255,20,.9)}",
    ".skin-alien #ovArtist{color:#22c006}",
    ".skin-alien #ovSeekFill{background:#39ff14;box-shadow:0 0 10px rgba(57,255,20,.9)}",
    ".skin-alien #ovBtns .play{background:#39ff14;color:#01130a;border-color:#39ff14}",
    '/* small (original) skin - compact one-liner like the first version */',
    '.skin-small #ovRoot{background:rgba(14,10,26,.95);border:1px solid rgba(168,85,247,.4);border-radius:12px;min-height:60px !important;box-shadow:0 6px 24px rgba(0,0,0,.6)}',
    '.skin-small #ovBody{padding:4px 10px;gap:8px;min-height:50px}',
    '.skin-small #ovArt{width:36px;height:36px}',
    '.skin-small #ovTitle{font-size:11px}',
    '.skin-small #ovArtist{font-size:10px;margin-top:0}',
    '.skin-small #ovTimes{display:none}',
    '.skin-small #ovSeek{height:3px;margin-top:2px}',
    '.skin-small #ovBtns button{width:26px;height:26px;font-size:11px;border-radius:7px}',
    '.skin-small #ovBtns .play{width:30px;height:30px;font-size:13px}',
    '.skin-small #ovBtns #ovLike{display:none}',
    '.skin-small #ovVol{display:none}',
    '.skin-small #ovFoot{display:none}',
    '/* settings panel */',
    '#ovSettingsPanel{position:absolute;inset:0;background:rgba(10,8,20,.97);z-index:10;display:flex;flex-direction:column;padding:14px;border-radius:16px;overflow-y:auto}',
    '#ovSettingsPanel h3{color:#f4f2ff;font-size:14px;margin-bottom:12px;font-family:inherit}',
    '#ovSettingsPanel label{color:rgba(244,242,255,.6);font-size:11px;display:block;margin:10px 0 4px}',
    '#ovSettingsPanel select,#ovSettingsPanel input[type=range]{width:100%;background:rgba(255,255,255,.08);color:#f4f2ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px;font-family:inherit;font-size:12px}',
    '#ovSettingsPanel button{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:8px;padding:8px 14px;cursor:pointer;font-family:inherit;font-size:12px;margin-top:10px}'
  ].join("\n");
  document.head.appendChild(css);

  const root = document.createElement("div");
  root.id = "ovRoot";
  root.innerHTML = [
    '<div id="ovDrag">',
    '  <div class="ttl">WICKED PLAYER</div>',
    '  <button id="ovHide" aria-label="Hide overlay" title="Hide (Ctrl+Alt+O reopens)">&mdash;</button>',
    '  <button id="ovClose" aria-label="Close overlay" title="Close">&#10005;</button>',
    '</div>',
    '<div id="ovBody">',
    '  <div id="ovArt" role="img" aria-label="Album art"></div>',
    '  <div id="ovMeta">',
    '    <div id="ovTitle">Loading...</div>',
    '    <div id="ovArtist">connecting to player</div>',
    '    <div id="ovTimes"><span id="ovPos">0:00</span> / <span id="ovDur">0:00</span></div>',
    '    <div id="ovSeek" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"><div id="ovSeekFill"></div></div>',
    '  </div>',
    '  <div id="ovBtns">',
    '    <button id="ovPrev" aria-label="Previous track" title="Previous">&#9198;</button>',
    '    <button id="ovPlay" class="play" aria-label="Play or pause" title="Play/Pause" disabled>&#9654;</button>',
    '    <button id="ovNext" aria-label="Next track" title="Next">&#9197;</button>',
    '    <button id="ovLike" aria-label="Like this track" title="Like">&#9825;</button>',
    '  </div>',
    '</div>',
    '<div id="ovFoot">',
    '  <select id="ovSkin" aria-label="Overlay skin">',
    '    <option value="winamp">Winamp</option>',
    '    <option value="xbox">Xbox 360</option>',
    '    <option value="wmp">WMP 10</option>',
    '    <option value="ipod">iPod</option>',
    '    <option value="alien">Alien</option>',
    '    <option value="minimal">Minimal</option>',
    '    <option value="small">Small (original)</option>',
    '  </select>',
    '  <input id="ovVol" type="range" min="0" max="100" value="80" aria-label="Volume" title="Volume">',
    '  <button id="ovSettings" aria-label="Overlay settings" title="Settings">&#9881;</button>',
    '  <div class="sp"></div>',
    '  <div class="hint">drag top bar &middot; Space play &middot; &larr;&rarr; seek &middot; L like</div>',
    '</div>',
    '<div id="ovStatus"><div class="big" id="stBig">Connecting...</div><div class="small" id="stSmall">open the main app if this stays</div></div>'
  ].join("\n");
  document.body.appendChild(root);

  const $ = function (id) { return document.getElementById(id); };
  const E = {
    art: $("ovArt"), title: $("ovTitle"), artist: $("ovArtist"),
    pos: $("ovPos"), dur: $("ovDur"), seek: $("ovSeek"), seekFill: $("ovSeekFill"),
    play: $("ovPlay"), prev: $("ovPrev"), next: $("ovNext"), like: $("ovLike"),
    vol: $("ovVol"), skin: $("ovSkin"), status: $("ovStatus"), stBig: $("stBig"), stSmall: $("stSmall"),
  };

  function applySkin(name) {
    root.className = (S.settings.compact ? "ov-root compact skin-" : "ov-root skin-") + (name || "winamp");
  }
  function applyCompact(c) {
    root.classList.toggle("compact", !!c);
  }

  function fmt(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(n / 60), sec2 = n % 60;
    return m + ":" + String(sec2).padStart(2, "0");
  }

  function render() {
    const st = S.state;
    if (!st.ok) return;
    if (st.hasTrack) {
      E.status.style.display = "none";
      E.title.textContent = st.title;
      E.artist.textContent = st.artist || "";
      E.play.disabled = false; E.next.disabled = false; E.prev.disabled = false; E.seek.disabled = false;
      E.play.innerHTML = st.playing ? "&#10074;&#10074;" : "&#9654;";
      E.play.setAttribute("aria-label", st.playing ? "Pause" : "Play");
      if (E.art.dataset.art !== (st.art || "")) {
        E.art.dataset.art = st.art || "";
        E.art.style.backgroundImage = st.art ? "url('" + st.art + "')" : "none";
      }
      const pct = st.dur ? Math.min(100, (st.pos / st.dur) * 100) : 0;
      E.seekFill.style.width = pct + "%";
      E.seek.setAttribute("aria-valuenow", String(Math.round(pct)));
      E.pos.textContent = fmt(st.pos);
      E.dur.textContent = fmt(st.dur);
    } else {
      E.status.style.display = "none";
      E.title.textContent = "Nothing playing";
      E.artist.textContent = "play something in the main app";
      E.play.disabled = true; E.next.disabled = true; E.prev.disabled = true; E.seek.disabled = true;
      E.art.style.backgroundImage = "none"; E.art.dataset.art = "";
    }
  }

  function setStatus(big, small) {
    E.status.style.display = "flex";
    E.stBig.textContent = big;
    E.stSmall.textContent = small;
  }

  /* ---------- IPC ---------- */
  wu.onOverlayState(function (raw) {
    if (!raw || typeof raw !== "object") return;
    S.connected = true;
    S.lastStateAt = Date.now();
    S.state = raw;
    render();
  });
  wu.onOverlaySettings(function (d) {
    if (!d) return;
    if (d.skin) { S.settings.skin = d.skin; E.skin.value = d.skin; applySkin(d.skin); }
    if (typeof d.compact === "boolean") { S.settings.compact = d.compact; applyCompact(d.compact); }
    if (typeof d.volume === "number") { S.settings.volume = d.volume; E.vol.value = String(Math.round(d.volume * 100)); }
  });

  /* ---------- controls ---------- */
  E.play.onclick = function () { if (!E.play.disabled) wu.overlayCmd({ type: "toggle" }); };
  E.next.onclick = function () { if (!E.next.disabled) wu.overlayCmd({ type: "next" }); };
  E.prev.onclick = function () { if (!E.prev.disabled) wu.overlayCmd({ type: "prev" }); };
  E.like.onclick = function () {
    const liked = E.like.classList.contains("liked");
    if (liked) { E.like.classList.remove("liked"); E.like.innerHTML = "&#9825;"; }
    else { E.like.classList.add("liked"); E.like.innerHTML = "&#9829;"; }
    wu.overlayCmd({ type: "like" });
  };
  E.seek.onclick = function (e) {
    if (E.seek.disabled) return;
    const r = E.seek.getBoundingClientRect();
    wu.overlayCmd({ type: "seek", value: ((e.clientX - r.left) / r.width) * (S.state.dur || 0) });
  };
  E.vol.onchange = function () {
    const v = parseInt(E.vol.value, 10) / 100;
    wu.overlayCmd({ type: "volume", value: v });
  };
  E.skin.onchange = function () {
    S.settings.skin = E.skin.value;
    applySkin(E.skin.value);
    wu.overlayCmd({ type: "ui", skin: E.skin.value });
  };
  $("ovHide").onclick = function () { wu.winctl("overlay"); };
  $("ovClose").onclick = function () { wu.winctl("overlay"); };
  $("ovSettings").onclick = function () {
    const panel = document.getElementById("ovSettingsPanel");
    if (panel) { panel.remove(); return; }
    const p = document.createElement("div");
    p.id = "ovSettingsPanel";
    p.innerHTML = [
      '<h3>Overlay Settings</h3>',
      '<label>Skin</label>',
      '<select id="setSkin"><option value="winamp">Winamp</option><option value="xbox">Xbox 360</option><option value="wmp">WMP 10</option><option value="ipod">iPod</option><option value="alien">Alien</option><option value="minimal">Minimal</option><option value="small">Small (original)</option></select>',
      '<label>Compact mode</label>',
      '<select id="setCompact"><option value="false">Full mini-player</option><option value="true">Compact pill</option></select>',
      '<label>Volume</label>',
      '<input type="range" id="setVol" min="0" max="100" value="' + Math.round(S.settings.volume * 100) + '">',
      '<button id="setClose">Done</button>'
    ].join("");
    root.appendChild(p);
    p.querySelector("#setSkin").value = S.settings.skin;
    p.querySelector("#setSkin").onchange = function () {
      S.settings.skin = this.value;
      applySkin(this.value);
      E.skin.value = this.value;
      wu.overlayCmd({ type: "ui", skin: this.value });
    };
    p.querySelector("#setCompact").value = String(S.settings.compact);
    p.querySelector("#setCompact").onchange = function () {
      S.settings.compact = this.value === "true";
      applyCompact(S.settings.compact);
      wu.overlayCmd({ type: "ui", compact: S.settings.compact });
    };
    p.querySelector("#setVol").value = String(Math.round(S.settings.volume * 100));
    p.querySelector("#setVol").oninput = function () {
      S.settings.volume = parseInt(this.value, 10) / 100;
      E.vol.value = this.value;
      wu.overlayCmd({ type: "volume", value: S.settings.volume });
    };
    p.querySelector("#setClose").onclick = function () { p.remove(); };
  };

  E.seek.addEventListener("keydown", function (e) {
    if (E.seek.disabled) return;
    const cur = S.state.pos || 0, dur = S.state.dur || 0;
    if (e.key === "ArrowRight") { e.preventDefault(); wu.overlayCmd({ type: "seek", value: Math.min(dur, cur + 5) }); }
    if (e.key === "ArrowLeft") { e.preventDefault(); wu.overlayCmd({ type: "seek", value: Math.max(0, cur - 5) }); }
  });

  window.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); if (!E.play.disabled) wu.overlayCmd({ type: "toggle" }); }
    else if (e.code === "ArrowRight" && e.shiftKey) { wu.overlayCmd({ type: "next" }); }
    else if (e.code === "ArrowLeft" && e.shiftKey) { wu.overlayCmd({ type: "prev" }); }
    else if (e.code === "ArrowUp") { e.preventDefault(); const v = Math.min(100, parseInt(E.vol.value, 10) + 5); E.vol.value = String(v); E.vol.onchange(); }
    else if (e.code === "ArrowDown") { e.preventDefault(); const v = Math.max(0, parseInt(E.vol.value, 10) - 5); E.vol.value = String(v); E.vol.onchange(); }
    else if (e.key === "l" || e.key === "L") { E.like.onclick(); }
    else if (e.key === "Escape") { wu.winctl("overlay"); }
  });

  try {
    const saved = localStorage.getItem("wp-overlay-skin");
    if (saved) { S.settings.skin = saved; E.skin.value = saved; }
  } catch {}
  applySkin(S.settings.skin);
  applyCompact(S.settings.compact);

  // disconnected watchdog
  setInterval(function () {
    if (!S.connected) { setStatus("Not connected", "open the main app first"); return; }
    if (Date.now() - S.lastStateAt > 6000) {
      S.connected = false;
      setStatus("Player disconnected", "open or restart the main app");
    } else {
      E.status.style.display = "none";
    }
  }, 2000);

  wu.overlayReady();
})();