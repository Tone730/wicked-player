/* Wicked Player — account chip + app integration
   Injected via index.html. Reads window.__WP_USER (server-injected),
   shows a small account pill, handles logout. */
(function () {
  if (window.__wpChipLoaded) return;
  window.__wpChipLoaded = true;

  const user = window.__WP_USER || null;

  // feed the community module the authenticated identity so profiles line up
  try {
    if (user && user.username) {
      localStorage.setItem('wp-me', JSON.stringify({ name: user.username }));
    }
  } catch {}

  const css = document.createElement('style');
  css.textContent = `
    #wp-chip { position: fixed; bottom: 86px; right: 12px; z-index: 9999; display: flex; align-items: center; gap: 8px;
      background: rgba(18,16,31,.85); border: 1px solid rgba(255,255,255,.1); border-radius: 999px;
      padding: 6px 8px 6px 14px; font-family: 'Outfit','Segoe UI',sans-serif; font-size: 12px; color: #f4f2ff;
      backdrop-filter: blur(8px); box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    #wp-chip b { font-weight: 700; }
    #wp-chip .role { color: #d8b4fe; font-size: 10px; font-weight: 800; letter-spacing: .5px; }
    #wp-chip button { background: rgba(255,255,255,.08); border: none; color: #f4f2ff; border-radius: 999px;
      padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }
    #wp-chip button:hover { background: rgba(253,164,175,.2); }
    #wp-chip img { width: 22px; height: 22px; border-radius: 50%; }
    .wp-admin-link { color: #d8b4fe; text-decoration: none; font-weight: 700; font-size: 11px; }
  `;
  document.head.appendChild(css);

  function render() {
    let chip = document.getElementById('wp-chip');
    if (!user) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'wp-chip';
      document.body.appendChild(chip);
    }
    const adminLink = user.role === 'admin' ? ' <a class="wp-admin-link" href="/admin">ADMIN</a>' : '';
    const av = user.discord && user.discord.avatar ? `<img src="${user.discord.avatar}" />` : '';
    chip.innerHTML = `${av}<span><b>${user.username}</b> <span class="role">${user.role.toUpperCase()}</span>${adminLink}</span><button id="wp-key" title="Change password">🔑</button><button id="wp-logout">Log out</button>`;
    const keyBtn = document.getElementById('wp-key');
    if (keyBtn) keyBtn.onclick = () => pwModal();
    document.getElementById('wp-logout').onclick = async () => {
      try { await fetch('/auth/logout', { method: 'POST' }); } catch {}
      localStorage.removeItem('wp-me');
      location.href = '/';
    };
  }

  /* ---- change own password ---- */
  function pwModal() {
    const old = document.getElementById('wp-pw');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.id = 'wp-pw';
    box.style.cssText = 'position:fixed;top:52px;right:12px;z-index:10001;background:rgba(18,16,31,.97);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px;width:270px;font-family:inherit;box-shadow:0 14px 40px rgba(0,0,0,.5);';
    box.innerHTML = `
      <div style="font-weight:800;font-size:13px;margin-bottom:10px;">Change password</div>
      <input id="wpPwCur" type="password" placeholder="current password" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:8px;font-size:13px;">
      <input id="wpPwNew" type="password" placeholder="new password (4+)" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f4f2ff;border-radius:9px;padding:9px 10px;margin-bottom:10px;font-size:13px;">
      <div style="display:flex;gap:6px;">
        <button id="wpPwGo" style="flex:1;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;border-radius:9px;padding:9px;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;">Save</button>
        <button id="wpPwX" style="background:rgba(255,255,255,.08);border:none;color:#f4f2ff;border-radius:9px;padding:9px 12px;cursor:pointer;font-family:inherit;font-size:12px;">✕</button>
      </div>
      <div id="wpPwMsg" style="font-size:11px;margin-top:8px;min-height:14px;"></div>`;
    document.body.appendChild(box);
    box.querySelector('#wpPwX').onclick = () => box.remove();
    box.querySelector('#wpPwGo').onclick = async () => {
      const msg = box.querySelector('#wpPwMsg');
      msg.style.color = '#fda4af';
      try {
        const r = await fetch('/auth/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: box.querySelector('#wpPwCur').value, next: box.querySelector('#wpPwNew').value }),
        });
        const d = await r.json();
        if (r.ok) { msg.style.color = '#34d399'; msg.textContent = 'Password updated ✓'; setTimeout(() => box.remove(), 1200); }
        else msg.textContent = d.error || 'Failed';
      } catch { msg.textContent = 'Network error'; }
    };
  }

  // hosted-server indicator: home button when running against a remote server
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && window.wickedUpdates && window.wickedUpdates.isDesktop) {
    const attachHome = () => {
      const chipEl = document.getElementById('wp-chip');
      if (!chipEl || chipEl.querySelector('.wp-home')) return;
      const home = document.createElement('button');
      home.className = 'wp-home';
      home.textContent = '⌂';
      home.title = 'Back to this device';
      home.style.cssText = 'background:rgba(255,255,255,.08);border:none;color:#f4f2ff;border-radius:999px;padding:4px 9px;font-size:12px;cursor:pointer;margin-left:2px;';
      home.onclick = () => { location.href = 'http://localhost:5000/?useLocal=1'; };
      chipEl.insertBefore(home, chipEl.querySelector('button'));
    };
    setInterval(attachHome, 2000);
  }

  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', render);
})();