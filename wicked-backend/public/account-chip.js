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
    #wp-chip { position: fixed; top: 10px; right: 12px; z-index: 9999; display: flex; align-items: center; gap: 8px;
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
    chip.innerHTML = `${av}<span><b>${user.username}</b> <span class="role">${user.role.toUpperCase()}</span>${adminLink}</span><button id="wp-logout">Log out</button>`;
    document.getElementById('wp-logout').onclick = async () => {
      try { await fetch('/auth/logout', { method: 'POST' }); } catch {}
      localStorage.removeItem('wp-me');
      location.href = '/';
    };
  }

  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', render);
})();