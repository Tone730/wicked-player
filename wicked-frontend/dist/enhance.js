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
  if (isOverlay) { buildOverlay(); return; }

  /* ---- 0. auth guard: never show "backend asleep" when it's just a logout ---- */
  const _origFetch = window.fetch;

  // stream resolve cache: instant re-play of tracks you already loaded
  const STREAM_KEY = 'wp-stream-cache';
  const streamMem = (() => { try { return JSON.parse(sessionStorage.getItem(STREAM_KEY) || '{}'); } catch { return {}; } })();
  const saveStream = () => { try { sessionStorage.setItem(STREAM_KEY, JSON.stringify(streamMem)); } catch {} };

  window.fetch = function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const sm = /\?q=([^&]+)/.exec(url);
    if (url.includes('/stream?q=') && sm) {
      const key = decodeURIComponent(sm[1]).toLowerCase();
      const hit = streamMem[key];
      if (hit && Date.now() - hit.at < 20 * 60 * 1000) {
        return Promise.resolve(new Response(JSON.stringify(hit.data), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return _origFetch.apply(this, args).then((res) => {
        if (res.ok) {
          res.clone().json().then((data) => { streamMem[key] = { at: Date.now(), data }; saveStream(); }).catch(() => {});
        }
        return res;
      });
    }
    return _origFetch.apply(this, args).then((res) => {
      if (res.status === 401 && !isOverlay) {
        res.clone().json().then((d) => {
          if (d && d.auth === true && d.error === 'Login required' && !document.getElementById('username')) {
            location.href = '/';
          }
        }).catch(() => {});
      }
      return res;
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
  function attachAudioHooks() {
    const a = getAudio();
    if (!a || a.__wpHooks) return false;
    a.__wpHooks = true;
    a.addEventListener('play', () => { const t = currentTrackFromUI(); if (t && t.name) lastTrack = t; });
    a.addEventListener('ended', onEnded);
    return true;
  }
  new MutationObserver(() => attachAudioHooks()).observe(document.documentElement, { childList: true, subtree: true });
  attachAudioHooks();

  async function onEnded() {
    if (window.__wpContinuing) return;
    await new Promise((r) => setTimeout(r, 1200));
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

  /* ============ PERF: preconnects ============ */
  for (const href of ['https://itunes.apple.com', 'https://api.deezer.com', 'https://i.scdn.co']) {
    if (!document.querySelector(`link[rel="preconnect"][href="${href}"]`)) {
      const l = document.createElement('link'); l.rel = 'preconnect'; l.href = href;
      document.head.appendChild(l);
    }
  }

  /* ============================================================
     OVERLAY IMPLEMENTATION
  ============================================================ */
  function buildOverlay() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', buildOverlay); return; }
    const wu = window.wickedUpdates;
    document.body.innerHTML = '';
    document.documentElement.style.background = 'transparent';
    document.body.style.cssText = 'margin:0;overflow:hidden;background:transparent;font-family:"Outfit","Segoe UI",sans-serif;';
    const rEl = document.getElementById('root');
    if (rEl) rEl.style.background = 'transparent';

    const css = document.createElement('style');
    css.textContent = `
      .ov-root { width:100vw; height:100vh; border-radius:16px; overflow:hidden; user-select:none;
        background:linear-gradient(160deg, rgba(18,16,31,.94), rgba(10,8,20,.96));
        border:1px solid rgba(255,255,255,.14); box-shadow:0 10px 40px rgba(0,0,0,.5);
        display:flex; flex-direction:column; }
      .ov-drag { -webkit-app-region: drag; height:26px; display:flex; align-items:center;
        padding:0 8px; cursor:move; background:rgba(255,255,255,.05); flex:0 0 auto; }
      .ov-drag .ttl { font-size:10px; letter-spacing:1px; color:rgba(244,242,255,.55); flex:1; font-weight:700; }
      .ov-drag button { -webkit-app-region:no-drag; }
      .ov-body { flex:1; display:flex; align-items:center; gap:12px; padding:10px 14px; }
      .ov-art { width:64px; height:64px; border-radius:10px; background:rgba(255,255,255,.06) center/cover no-repeat; flex:0 0 auto; }
      .ov-meta { flex:1; min-width:0; }
      .ov-title { font-weight:800; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ov-artist { font-size:12px; color:rgba(244,242,255,.6); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
      .ov-prog { height:5px; border-radius:3px; background:rgba(255,255,255,.12); margin-top:10px; cursor:pointer; }
      .ov-prog > div { height:100%; border-radius:3px; background:linear-gradient(90deg,#a855f7,#ec4899); width:0%; }
      .ov-btns { display:flex; gap:6px; align-items:center; margin-left:6px; -webkit-app-region:no-drag; }
      .ov-btns button { background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); color:#f4f2ff;
        border-radius:9px; width:34px; height:34px; cursor:pointer; font-size:13px; }
      .ov-btns button:hover { border-color:#a855f7; }
      .ov-btns .play { width:44px; height:44px; font-size:16px; background:linear-gradient(135deg,#a855f7,#ec4899); border:none; }
      .ov-foot { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:4px 10px 8px; }
      .ov-foot select { -webkit-app-region:no-drag; background:rgba(255,255,255,.08); color:#f4f2ff; border:1px solid rgba(255,255,255,.12);
        border-radius:8px; font-size:11px; padding:3px 6px; font-family:inherit; }
      .ov-foot .sp { flex:1; }
      .ov-foot button { -webkit-app-region:no-drag; background:none; border:none; color:rgba(244,242,255,.55); font-size:11px; cursor:pointer; }
      .ov-foot button:hover { color:#f4f2ff; }
      /* ---- RETRO FACEPLATE SKINS ---- */
      .ov-root { border-radius:16px; }
      /* WINAMP CLASSIC — charcoal bevel, green LCD, gold trim */
      .ov-root.skin-winamp { background:linear-gradient(180deg,#3a3d36 0%,#23251f 40%,#141512 100%);
        border:3px solid #0a0b09; border-radius:6px;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.25), inset 0 -2px 6px rgba(0,0,0,.8), 0 10px 30px rgba(0,0,0,.6); }
      .skin-winamp .ov-drag { background:linear-gradient(180deg,#4c4f45,#2c2e27); border-bottom:1px solid #0a0b09; }
      .skin-winamp .ov-drag .ttl { color:#d7cba0; font-family:Georgia,serif; font-style:italic; font-weight:700; }
      .skin-winamp .ov-body { background:linear-gradient(180deg,#0e1210,#050706); margin:6px 8px; border-radius:3px;
        border:2px solid #14150f; box-shadow:inset 0 0 18px rgba(0,0,0,.9); position:relative; overflow:hidden; }
      .skin-winamp .ov-body::after { content:''; position:absolute; inset:0; pointer-events:none;
        background:repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px); }
      .skin-winamp .ov-title { color:#29e07f; font-family:Consolas,monospace; letter-spacing:1px; text-shadow:0 0 6px rgba(41,224,127,.7); }
      .skin-winamp .ov-artist { color:#8fbf9f; font-family:Consolas,monospace; }
      .skin-winamp .ov-prog { background:#0a0d0b; border:1px solid #20241f; }
      .skin-winamp .ov-prog > div { background:#29e07f; box-shadow:0 0 8px rgba(41,224,127,.8); }
      .skin-winamp .ov-btns button { background:linear-gradient(180deg,#5a5d52,#34362e); border:2px solid #0a0b09;
        color:#d7cba0; border-radius:3px; box-shadow:inset 0 1px 0 rgba(255,255,255,.2); }
      .skin-winamp .ov-btns .play { background:linear-gradient(180deg,#29e07f,#0e8f4a); color:#04130a; }
      .skin-winamp .ov-foot { background:linear-gradient(180deg,#23251f,#141512); }
      /* XBOX 360 BLADE — green glow, silver edges, center orb */
      .ov-root.skin-xbox { background:linear-gradient(160deg,#f4f6f8 0%,#cfd6dd 30%,#eef1f4 100%); border:none; border-radius:20px;
        box-shadow:0 12px 34px rgba(0,0,0,.45), inset 0 0 0 2px rgba(255,255,255,.7); position:relative; overflow:hidden; }
      .ov-root.skin-xbox::before { content:''; position:absolute; left:-30%; top:-120%; width:160%; height:260%;
        background:linear-gradient(115deg, transparent 42%, rgba(155,240,11,.35) 50%, transparent 58%); transform:rotate(8deg); pointer-events:none; }
      .skin-xbox .ov-drag { background:linear-gradient(90deg,#9bf00b33,#e9fbcd); }
      .skin-xbox .ov-drag .ttl { color:#37610c; font-weight:900; }
      .skin-xbox .ov-drag .ttl::before { content:'ⓧ '; color:#9bf00b; }
      .skin-xbox .ov-body { background:linear-gradient(180deg,#ffffff,#e6f5cf); border:1px solid #b9d68a; border-radius:12px; }
      .skin-xbox .ov-title { color:#23350a; }
      .skin-xbox .ov-artist { color:#5d7a33; }
      .skin-xbox .ov-prog { background:#d4e8b0; }
      .skin-xbox .ov-prog > div { background:linear-gradient(90deg,#9bf00b,#5faa06); }
      .skin-xbox .ov-btns button { background:#fff; border:2px solid #b9d68a; color:#37610c; border-radius:12px; }
      .skin-xbox .ov-btns .play { background:radial-gradient(circle at 35% 30%,#c5ff4d,#76c407); color:#fff; border-color:#5faa06; }
      /* WMP 10 — blue glass, orange play, silver frame */
      .ov-root.skin-wmp { background:linear-gradient(180deg,#1b3a6b 0%,#122a52 45%,#0a1830 100%);
        border:2px solid #6d9bd8; border-radius:10px;
        box-shadow:inset 0 1px 0 rgba(160,200,255,.4), 0 10px 30px rgba(0,0,0,.55); }
      .skin-wmp .ov-drag { background:linear-gradient(180deg,#2c549b,#16305e); border-bottom:1px solid #0b1a38; }
      .skin-wmp .ov-drag .ttl { color:#cfe4ff; }
      .skin-wmp .ov-drag .ttl::before { content:'▶ '; color:#ff9a2e; }
      .skin-wmp .ov-body { background:linear-gradient(180deg,#0e2145,#091731); border:1px solid #2b4d8f; border-radius:6px; }
      .skin-wmp .ov-title { color:#eaf3ff; }
      .skin-wmp .ov-artist { color:#9dbce6; }
      .skin-wmp .ov-prog { background:#0a1830; border:1px solid #2b4d8f; }
      .skin-wmp .ov-prog > div { background:linear-gradient(90deg,#ff9a2e,#ffc46e); box-shadow:0 0 8px rgba(255,154,46,.6); }
      .skin-wmp .ov-btns button { background:linear-gradient(180deg,#3f6db5,#1d3f7e); border:1px solid #0b1a38; color:#dcebff; border-radius:5px; }
      .skin-wmp .ov-btns .play { background:linear-gradient(180deg,#ffb35c,#f07f10); color:#3a1d00; }
      /* IPOD CLASSIC — polished steel, gray LCD, click-wheel feel */
      .ov-root.skin-ipod { background:linear-gradient(145deg,#f8f9fb 0%,#d9dde3 50%,#c3c8d0 100%);
        border:1px solid #9aa0ab; border-radius:26px;
        box-shadow:inset 0 2px 2px rgba(255,255,255,.9), inset 0 -3px 8px rgba(0,0,0,.18), 0 12px 32px rgba(0,0,0,.4); }
      .skin-ipod .ov-drag { background:transparent; }
      .skin-ipod .ov-drag .ttl { color:#7d838e; font-weight:700; }
      .skin-ipod .ov-body { background:linear-gradient(180deg,#cdd3da,#b4bac2); border:2px solid #868c97;
        border-radius:8px; box-shadow:inset 0 2px 6px rgba(0,0,0,.35); }
      .skin-ipod .ov-title { color:#16181d; }
      .skin-ipod .ov-artist { color:#454a53; }
      .skin-ipod .ov-prog { background:rgba(0,0,0,.2); }
      .skin-ipod .ov-prog > div { background:#16181d; }
      .skin-ipod .ov-btns button { background:linear-gradient(180deg,#eef0f3,#c9cdd4); border:1px solid #868c97;
        color:#2b2e35; border-radius:50%; width:38px; height:38px; box-shadow:inset 0 1px 0 #fff; }
      .skin-ipod .ov-btns .play { background:linear-gradient(180deg,#2b2e35,#0f1114); color:#fff; border-color:#000; }
      .skin-ipod .ov-foot { background:transparent; }
      /* ALIEN HEAD — CRT phosphor green, scanlines, glow */
      .ov-root.skin-alien { background:radial-gradient(ellipse at 50% 0%, #062d12 0%, #010d06 70%);
        border:2px solid #39ff14; border-radius:50px;
        box-shadow:0 0 26px rgba(57,255,20,.4), inset 0 0 30px rgba(57,255,20,.12); }
      .skin-alien .ov-body { position:relative; overflow:hidden; background:rgba(1,10,4,.6); border-radius:36px; }
      .skin-alien .ov-body::after { content:''; position:absolute; inset:0; pointer-events:none;
        background:repeating-linear-gradient(0deg, rgba(57,255,20,.06) 0 2px, transparent 2px 4px); }
      .skin-alien .ov-drag .ttl::before { content:'👽 '; }
      .skin-alien .ov-title { color:#39ff14; text-shadow:0 0 10px rgba(57,255,20,.9); }
      .skin-alien .ov-artist { color:#22c006; }
      .skin-alien .ov-prog { background:#02160a; }
      .skin-alien .ov-prog > div { background:#39ff14; box-shadow:0 0 10px rgba(57,255,20,.9); }
      .skin-alien .ov-btns button { background:rgba(57,255,20,.08); border:1px solid #39ff14; color:#39ff14; border-radius:22px; }
      .skin-alien .ov-btns .play { background:#39ff14; color:#01130a; border-color:#39ff14; }
      .skin-alien .ov-foot select { background:#02160a; color:#39ff14; border-color:#39ff14; }
      /* VIDEO MODE: give the iframe a skin-matching frame */
      #ovVid iframe { border-radius:inherit; }    `;
    document.head.appendChild(css);

    const root = document.createElement('div');
    root.innerHTML = `
      <div class="ov-root" id="ovRoot">
        <div class="ov-drag" id="ovDrag">
          <div class="ttl">WICKED PLAYER — OVERLAY</div>
          <button id="ovMin" title="Hide overlay (Ctrl+Alt+O brings it back)">—</button>
          <button id="ovClose" title="Close overlay">✕</button>
        </div>
        <div class="ov-body">
          <div class="ov-art" id="ovArt"></div>
          <div class="ov-meta">
            <div class="ov-title" id="ovTitle">Nothing playing</div>
            <div class="ov-artist" id="ovArtist">—</div>
            <div class="ov-prog" id="ovProg"><div id="ovProgFill"></div></div>
          </div>
          <div class="ov-btns">
            <button id="ovPrev">⏮</button>
            <button class="play" id="ovPlay">▶</button>
            <button id="ovNext">⏭</button>
          </div>
        </div>
        <div class="ov-foot">
          <button id="ovVideo" title="Music video (YouTube watch mode)">🎬</button>
          <select id="ovSkin">
            <option value="minimal">Minimal (dark glass)</option>
            <option value="winamp">Winamp classic</option>
            <option value="xbox">Xbox 360</option>
            <option value="wmp">Windows Media Player 10</option>
            <option value="ipod">iPod classic</option>
            <option value="alien">Alien head</option>
          </select>
          <div class="sp"></div>
          
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.getElementById('ovDrag').style.webkitAppRegion = 'drag';

    // apply saved skin
    const saved = localStorage.getItem('wp-overlay-skin') || 'winamp';
    applySkin(saved);
    document.getElementById('ovSkin').value = saved;
    document.getElementById('ovSkin').onchange = (e) => {
      localStorage.setItem('wp-overlay-skin', e.target.value);
      applySkin(e.target.value);
    };
    function applySkin(s) {
      const r = document.getElementById('ovRoot');
      r.className = 'ov-root' + (s && s !== 'minimal' ? ' skin-' + s : '');
    }

    const $ = (id) => document.getElementById(id);
    $('ovClose').onclick = () => wu.winctl('overlay');
    const mn = $('ovMin');
    if (mn) mn.onclick = () => wu.winctl('overlay');
    $('ovMini').onclick = () => wu.winctl('overlay');
    $('ovPlay').onclick = () => wu.overlayCmd({ type: 'toggle' });
    $('ovPrev').onclick = () => wu.overlayCmd({ type: 'prev' });
    $('ovNext').onclick = () => wu.overlayCmd({ type: 'next' });
    $('ovProg').onclick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      wu.overlayCmd({ type: 'seek', value: ((e.clientX - rect.left) / rect.width) * (state.dur || 0) });
    };

    let state = { playing: false, title: '', artist: '', art: null, pos: 0, dur: 0 };
    if (wu.onOverlayHello) wu.onOverlayHello(() => { /* server acknowledged */ });
    fetch('/auth/me').then((r) => r.json()).then((d) => {
      if (!d.user) {
        $('ovTitle').textContent = 'Open the main app & sign in';
        $('ovArtist').textContent = 'overlay connects automatically';
      }
    }).catch(() => {});
    if (wu) wu.onOverlayState((s) => {
      state = s || state;
      $('ovTitle').textContent = state.title || 'Nothing playing';
      $('ovArtist').textContent = state.artist || '—';
      $('ovPlay').textContent = state.playing ? '⏸' : '▶';
      $('ovArt').style.backgroundImage = state.art ? `url('${state.art}')` : 'none';
      const pct = state.dur ? Math.min(100, (state.pos / state.dur) * 100) : 0;
      $('ovProgFill').style.width = pct + '%';
    });
    // ---- video mode: YouTube embed watch-mode for the current track ----
    let videoOn = false;
    $('ovVideo').onclick = () => {
      const bodyEl = document.querySelector('.ov-body');
      if (!videoOn) {
        if (wu) wu.overlayCmd({ type: 'pause' });
        const q = encodeURIComponent(((state.title || '') + ' ' + (state.artist || '')).trim() || 'lofi hip hop');
        const rootEl = document.getElementById('ovRoot');
        rootEl.style.height = '100vh';
        document.querySelector('.ov-drag').insertAdjacentHTML('afterend',
          '<div id="ovVid" style="flex:1;min-height:0;"><iframe style="width:100%;height:100%;border:0;" ' +
          'src="https://www.youtube.com/embed?listType=search&list=' + q + '" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>');
        bodyEl.style.display = 'none';
        $('ovVideo').textContent = '🎵';
        videoOn = true;
      } else {
        const v = document.getElementById('ovVid');
        if (v) v.remove();
        document.getElementById('ovRoot').style.height = '';
        bodyEl.style.display = '';
        $('ovVideo').textContent = '🎬';
        videoOn = false;
      }
    };

    if (wu) wu.overlayReady();
  }
})();