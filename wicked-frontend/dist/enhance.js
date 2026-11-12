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

  /* ---- gift / premium code redemption panel ---- */
  function giftModal() {
    const old = document.getElementById('wp-gift-panel');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.id = 'wp-gift-panel';
    box.style.cssText = 'position:fixed;bottom:130px;right:12px;z-index:10001;background:rgba(18,16,31,.97);border:1px solid rgba(168,85,247,.4);border-radius:14px;padding:16px;width:290px;font-family:inherit;box-shadow:0 14px 40px rgba(0,0,0,.5);';
    box.innerHTML = [
      '<div style="font-weight:800;font-size:13px;margin-bottom:10px;color:#d8b4fe;">\u{1F381} Redeem a gift code</div>',
      '<input id="wpGiftCode" placeholder="WK-XXXXXX or premium code" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:8px;font-size:13px;text-transform:uppercase;">',
      '<button id="wpGiftGo" style="width:100%;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;border-radius:9px;padding:9px;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;margin-bottom:10px;">Redeem</button>',
      '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px;margin-bottom:8px;">',
      '  <div style="font-weight:700;font-size:12px;margin-bottom:6px;">No code? Request premium</div>',
      '  <input id="wpGiftMsg" placeholder="tell the admin why (optional)" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:8px;font-size:13px;">',
      '  <button id="wpGiftReq" style="width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px;font-weight:600;cursor:pointer;font-family:inherit;font-size:12px;">Send request to admin</button>',
      '</div>',
      '<div id="wpGiftMsgOut" style="font-size:11px;margin-top:8px;min-height:16px;"></div>',
      '<button id="wpGiftX" style="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(244,242,255,.5);cursor:pointer;font-size:14px;">\u2715</button>'
    ].join('');
    document.body.appendChild(box);
    box.querySelector('#wpGiftX').onclick = function () { box.remove(); };
    box.querySelector('#wpGiftGo').onclick = async function () {
      const out = box.querySelector('#wpGiftMsgOut');
      out.style.color = '#fda4af';
      try {
        const r = await fetch('/api/reward/redeem', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: box.querySelector('#wpGiftCode').value }),
        });
        const d = await r.json();
        if (r.ok) { out.style.color = '#34d399'; out.textContent = '\u{1F389} Premium active for ' + d.days + ' days!'; }
        else out.textContent = d.error || 'Failed';
      } catch { out.textContent = 'Network error'; }
    };
    box.querySelector('#wpGiftReq').onclick = async function () {
      const out = box.querySelector('#wpGiftMsgOut');
      out.style.color = '#fda4af';
      try {
        const r = await fetch('/api/premium/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: (window.__WP_USER || {}).username, message: box.querySelector('#wpGiftMsg').value }),
        });
        const d = await r.json();
        if (r.ok) { out.style.color = '#34d399'; out.textContent = 'Request sent - the admin will review it.'; }
        else out.textContent = d.error || 'Failed';
      } catch { out.textContent = 'Network error'; }
    };
  }
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
  po.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
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
    box.innerHTML = '<div style="font-weight:800;font-size:13px;margin-bottom:10px;color:#d8b4fe">&#127873; Redeem a gift code</div><input id="wpGiftCode" placeholder="WK-XXXXXX" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:8px;font-size:13px;text-transform:uppercase"><button id="wpGiftGo" style="width:100%;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;border-radius:9px;padding:9px;font-weight:700;cursor:pointer;font-size:12px;margin-bottom:10px;color:#fff">Redeem</button><div style="border-top:1px solid rgba(255,255,255,.1);padding-top:10px"><div style="font-weight:700;font-size:12px;margin-bottom:6px">No code? Request premium</div><input id="wpGiftMsg" placeholder="tell the admin why" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:8px;font-size:13px"><button id="wpGiftReq" style="width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px;font-weight:600;cursor:pointer;font-size:12px">Send request</button></div><div id="wpGiftOut" style="font-size:11px;margin-top:8px;min-height:16px"></div><button id="wpGiftX" style="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(244,242,255,.5);cursor:pointer;font-size:14px">&#10005;</button>';
    document.body.appendChild(box);
    box.querySelector("#wpGiftX").onclick = function() { box.remove(); };
    box.querySelector("#wpGiftGo").onclick = function() { var out = box.querySelector("#wpGiftOut"); out.style.color = "#fda4af"; fetch("/api/reward/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: box.querySelector("#wpGiftCode").value }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { out.style.color = "#34d399"; out.textContent = "Premium active for " + d.days + " days!"; } else out.textContent = d.error; }).catch(function() { out.textContent = "Network error"; }); };
    box.querySelector("#wpGiftReq").onclick = function() { var out = box.querySelector("#wpGiftOut"); out.style.color = "#fda4af"; fetch("/api/premium/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: (window.__WP_USER || {}).username, message: box.querySelector("#wpGiftMsg").value }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { out.style.color = "#34d399"; out.textContent = "Request sent!"; } else out.textContent = d.error; }).catch(function() { out.textContent = "Network error"; }); };
  }
  var chip = document.getElementById("wp-chip");
  if (chip && !chip.querySelector("#wp-gift")) { var gb = document.createElement("button"); gb.id = "wp-gift"; gb.title = "Gifts"; gb.innerHTML = "\u{1F381}"; gb.onclick = function() { giftModal(); }; chip.insertBefore(gb, chip.querySelector("button")); }
  var bgBtn = document.createElement("button"); bgBtn.id = "wp-bg-btn"; bgBtn.title = "Background"; bgBtn.innerHTML = "\u{1F3A8}"; bgBtn.onclick = function() { bgPanel(); }; if (chip) chip.insertBefore(bgBtn, chip.querySelector("button"));
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