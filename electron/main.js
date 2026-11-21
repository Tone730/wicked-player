const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { globalShortcut } = require('electron');

let win = null;
let overlay = null;
let backendProc = null;
let tray = null;

/* single instance + wicked:// protocol */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.setAsDefaultProtocolClient('wicked');

/* ---------- bundled backend (runs inside Electron's node runtime) ---------- */
function backendDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');
}

function backendUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/api/status', { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureBackend() {
  if (await backendUp()) return;
  const dir = backendDir();
  const script = path.join(dir, 'server.js');
  if (!fs.existsSync(script)) return;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  backendProc = spawn(process.execPath, [script], { cwd: dir, env, stdio: 'ignore' });
  backendProc.on('error', () => { backendProc = null; });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await backendUp()) break;
  }
}

app.on('quit', () => {
  try { if (backendProc) backendProc.kill(); } catch {}
});

/* home server: local by default, or a hosted server set via login page / prefs */
function fetchHomeServer() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/local/prefs', { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const prefs = JSON.parse(body);
          if (prefs.homeServer && /^https?:\/\//.test(prefs.homeServer)) return resolve(prefs.homeServer);
        } catch {}
        resolve('https://wickedplayer.dev');
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('https://wickedplayer.dev'); });
    req.on('error', () => resolve('https://wickedplayer.dev'));
  });
}

/* ---------- discord rich presence ---------- */
let rpc = null, rpcReady = false, rpcConnecting = false, rpcClientId = null;
let rpcRetryTimer = null, rpcRetryDelay = 5000;
let lastRpcTrack = null;
/* profile-driven presence (pushed by the renderer once logged in) */
let profilePresence = null;
let presenceEnabled = true;
let lastPresenceSignature = '';
let lastTrackKey = '';
let presenceStart = Math.floor(Date.now() / 1000);
function clip(v, max) { return String(v == null ? '' : v).slice(0, max); }
function clearPresence() {
  try { if (rpc && rpcReady) rpc.clearActivity(); } catch {}
  lastPresenceSignature = '';
}
function applyPresenceConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  profilePresence = cfg;
  presenceEnabled = cfg.enabled !== false;
  if (!presenceEnabled) clearPresence();
  else if (lastRpcTrack) setPresence(lastRpcTrack.track, lastRpcTrack.playing, true);
}

function dataDir() {
  const d = path.join(backendDir(), 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function getDiscordClientId() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'discord-app.json'), 'utf8'));
    if (cfg.clientId) return cfg.clientId;
  } catch {}
  return process.env.DISCORD_CLIENT_ID || null;
}
function scheduleRpcRetry() {
  if (rpcRetryTimer) return;
  rpcRetryTimer = setTimeout(() => {
    rpcRetryTimer = null;
    rpc = null; rpcClientId = null; rpcReady = false; rpcConnecting = false;
    initDiscord();
  }, rpcRetryDelay);
  rpcRetryDelay = Math.min(60000, rpcRetryDelay * 2);
}
function initDiscord() {
  const clientId = getDiscordClientId();
  if (!clientId) return;
  if ((rpc && rpcClientId === clientId) || rpcRetryTimer) return;
  try { if (rpc) { rpc.destroy(); } } catch {}
  rpc = null; rpcReady = false; rpcConnecting = true;
  try {
    const { Client } = require('discord-rpc');
    rpc = new Client({ transport: 'ipc' });
    rpc.on('ready', () => {
      rpcReady = true; rpcConnecting = false; rpcRetryDelay = 5000;
      if (rpcRetryTimer) { clearTimeout(rpcRetryTimer); rpcRetryTimer = null; }
      console.log('[rpc] discord presence ready');
      /* Discord can start after the app, and a login can finish after the
         first track change. Re-send whatever was playing last. */
      if (lastRpcTrack) setPresence(lastRpcTrack.track, lastRpcTrack.playing, true);
    });
    rpc.on('disconnected', () => {
      rpcReady = false; rpcConnecting = false;
      console.log('[rpc] discord disconnected; will retry');
      scheduleRpcRetry();
    });
    rpc.login({ clientId }).catch((e) => {
      rpcReady = false; rpcConnecting = false;
      console.log('[rpc] discord login failed: ' + ((e && e.message) || e));
      try { if (rpc) { rpc.destroy(); } } catch {}
      rpc = null;
      scheduleRpcRetry();
    });
    rpcClientId = clientId;
  } catch (e) {
    rpc = null; rpcReady = false; rpcConnecting = false;
    scheduleRpcRetry();
  }
}
function setPresence(track, playing, force) {
  lastRpcTrack = { track, playing: !!playing };
  if (!presenceEnabled) { clearPresence(); return; }
  if (!rpc || !rpcReady) {
    if (!rpcRetryTimer && !rpcConnecting) initDiscord();
    return;
  }
  const hasTrack = !!(track && (track.name || track.title));
  const name = clip(hasTrack ? (track.name || track.title) : 'Nothing selected', 120);
  const artist = clip((track && track.artist) || '', 120);
  const album = clip((track && track.album) || '', 120);
  const isPlaying = !!playing;
  const prof = profilePresence || {};
  const pos = Math.max(0, Math.floor((track && track.elapsed) || 0));
  const key = name + '|' + artist;
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    presenceStart = Math.floor(Date.now() / 1000) - pos;
  }
  const activity = {
    type: 2, // Discord activity type 2 = "Listening to"
    details: clip(prof.details || ((isPlaying ? '▶ ' : '⏸ ') + name), 120),
    state: clip(prof.state || ([artist, 'Wicked Player' + (isPlaying ? '' : ' · paused')].filter(Boolean).join(' · ')), 120),
    startTimestamp: presenceStart,
    largeImageKey: clip(prof.image || (track && track.art) || 'wicked', 256),
    largeImageText: clip(((album ? album + ' · ' : '') + name + ' · Wicked Player'), 120),
    smallImageKey: clip(prof.avatar || 'wicked', 256),
    smallImageText: isPlaying ? 'Playing in Wicked Player' : 'Paused in Wicked Player',
    instance: false,
  };
  const buttons = [];
  const buttonUrl = clip(prof.buttonUrl || prof.profileUrl || '', 300);
  if (buttonUrl) buttons.push({ label: clip(prof.buttonLabel || 'View profile', 28), url: buttonUrl });
  if (prof.invite) buttons.push({ label: 'Join Discord', url: clip(prof.invite, 300) });
  if (buttons.length) activity.buttons = buttons.slice(0, 2);
  const sig = JSON.stringify(activity);
  if (!force && sig === lastPresenceSignature) return;
  lastPresenceSignature = sig;
  rpc.setActivity(activity).catch(() => {
    rpcReady = false;
    scheduleRpcRetry();
  });
}

/* ---------- system tray player ---------- */
let lastTrayTrack = null;
function trayIconPath() {
  try {
    const dest = path.join(app.getPath('userData'), 'wicked-tray.png');
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(__dirname, 'icon.png'), dest);
    return dest;
  } catch { return path.join(__dirname, 'icon.png'); }
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIconPath());
    tray.setToolTip('Wicked Player');
    const template = [
      { label: 'Show Wicked Player', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: 'Play / Pause', click: () => runOverlayCmd({ type: 'toggle' }) },
      { label: 'Next track', click: () => runOverlayCmd({ type: 'next' }) },
      { label: 'Previous track', click: () => runOverlayCmd({ type: 'prev' }) },
      { type: 'separator' },
      { label: 'Mini player', click: () => { try { ipcMain.emit('winctl', {}, 'mini'); } catch {} } },
      { label: 'Floating overlay', click: () => toggleOverlay() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ];
    try { tray.setContextMenu(Menu.buildFromTemplate(template)); } catch {}
    tray.on('click', () => { if (win) { if (win.isVisible()) win.focus(); else { win.show(); win.focus(); } } });
  } catch (e) { console.error('[tray] init failed', e && e.message); tray = null; }
}
function updateTray(track, playing) {
  if (!tray) return;
  try {
    lastTrayTrack = track || null;
    const name = track && (track.name || track.title) ? (track.name || track.title) : '';
    const artist = track && track.artist ? track.artist : '';
    try { if (process.platform === 'darwin') tray.setTitle(name && playing ? ('\u25B6 ' + name).slice(0, 32) : ''); } catch {}
    tray.setToolTip(name ? (name + (artist ? ' \u2014 ' + artist : '') + (playing ? ' \u25B6' : '')) : 'Wicked Player');
  } catch {}
}

/* ---------- UI location (kept for packaged fallback) ---------- */
function uiDir() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'wicked-frontend', 'dist');
  const candidates = [
    path.join(process.resourcesPath, 'app-ui'),
    path.join(path.dirname(app.getPath('exe')), 'app-ui'),
  ];
  for (const c of candidates) { if (fs.existsSync(path.join(c, 'index.html'))) return c; }
  return candidates[0];
}

/* ---------- main window ---------- */
let uiLoaded = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#07060d',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0912', symbolColor: '#d0cce4', height: 32 },
    title: 'Wicked Player',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.on('minimize', () => {
    // normal minimize — the overlay window keeps running on top of everything
    try { if (overlay && overlay.isVisible()) { /* overlay stays */ } } catch {}
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => { uiLoaded = true; });
  win.on('closed', () => { win = null; });

  /* load through the backend's login gate — or a remote server if set
     (hosted mode: friends point their app at the host's server) */
  ensureBackend().then(() => {
    initDiscord();
    fetchHomeServer().then((homeUrl) => {
      win.loadURL(homeUrl + '/');
      setTimeout(() => {
        if (!uiLoaded) { try { shell.openExternal(homeUrl); } catch {} }
      }, 15000);
    });
  });
}

/* ---------- external overlay window (draggable, works over games) ---------- */
function createOverlay() {
  var b = getSavedBounds();
  overlay = new BrowserWindow({
    width: b ? b.width : 440,
    height: b ? b.height : 190,
    minWidth: 240,
    minHeight: 60,
    maxWidth: 1400,
    maxHeight: 800,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    title: "Wicked Overlay",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.on("closed", function () { overlay = null; });
  overlay.on("moved", function () { saveOverlayBounds(); });
  overlay.on("resized", function () { saveOverlayBounds(); });
}

function getSavedBounds() {
  try {
    var f = path.join(app.getPath("userData"), "overlay-bounds.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {}
  return null;
}

function saveOverlayBounds() {
  if (!overlay || overlay.isDestroyed()) return;
  try {
    var f = path.join(app.getPath("userData"), "overlay-bounds.json");
    fs.writeFileSync(f, JSON.stringify(overlay.getBounds()));
  } catch {}
}

function showOverlay() {
  if (!overlay || overlay.isDestroyed()) createOverlay();
  if (!overlay) return;
  overlay.show();
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.moveTop();
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) { overlay.hide(); return; }
  if (!overlay) createOverlay();
  if (!overlay) return;
  overlay.show();
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.moveTop();
}

/* ---------- IPC ---------- */
ipcMain.on('presence', (_e, { track, playing }) => { setPresence(track, playing); updateTray(track, playing); });
ipcMain.on('presence:config', (_e, cfg) => applyPresenceConfig(cfg));
ipcMain.on('presence:enabled', (_e, enabled) => {
  presenceEnabled = !!enabled;
  if (!presenceEnabled) clearPresence();
  else if (lastRpcTrack) setPresence(lastRpcTrack.track, lastRpcTrack.playing, true);
});
ipcMain.handle('presence:status', () => ({
  ready: !!rpcReady,
  enabled: presenceEnabled,
  clientId: rpcClientId || getDiscordClientId(),
  configured: !!profilePresence,
  displayName: profilePresence ? profilePresence.displayName || '' : '',
}));

/* ---------- overlay plumbing: main process drives everything ----------
   State is polled straight from the main window's audio element via
   executeJavaScript (works while minimized), and overlay commands are
   executed the same way. No renderer-to-renderer relay, no timers in
   the game's way. */
let stateTimer = null;
let lastPresenceAt = 0;

function readPlayerState() {
  return win?.webContents
    ?.executeJavaScript(
      `(() => {
        const a = document.querySelector('audio');
        const bar = document.querySelector('footer, [class*="foobar"], [class*="bar-center"]');
        const lines = (bar ? (bar.innerText || '') : '').split('\n').map(s => s.trim()).filter(Boolean);
        let art = null;
        const img = document.querySelector('footer img, [class*="track-art"] img');
        if (img) art = img.src;
        else {
          const el = document.querySelector('[class*="track-art"] [style*="background"]');
          if (el) { const m = /url\(["']?([^"')]+)/.exec(el.style.backgroundImage || ''); if (m) art = m[1]; }
        }
        return JSON.stringify({
          playing: a ? !a.paused : false,
          title: lines[0] || '',
          artist: lines[1] || '',
          art: art,
          pos: a ? a.currentTime : 0,
          dur: a ? (a.duration || 0) : 0
        });
      })()`,
      false
    )
    .then((r) => { try { return JSON.parse(r); } catch { return null; } })
    .catch(() => null);
}

async function pushOverlayState() {
  if (!win) return;
  const st = await readPlayerState();
  if (!st) return;
  if (overlay && overlay.isVisible()) { try { overlay.webContents.send('overlay:state', st); } catch {} }
  // discord presence + tray tooltip ride the same poll (2s refresh)
  if (st.title && Date.now() - lastPresenceAt > 2000) {
    lastPresenceAt = Date.now();
    setPresence({ name: st.title, artist: st.artist, album: '', art: st.art, elapsed: st.pos }, st.playing);
    updateTray({ name: st.title, artist: st.artist }, st.playing);
  }
}

function startStateTimer() {
  if (stateTimer) return;
  stateTimer = setInterval(() => { pushOverlayState().catch(() => {}); }, 500);
}

function execDriver(js) {
  if (!win) return;
  win.webContents.executeJavaScript(js, false).catch(() => {});
}

function runOverlayCmd(cmd) {
  const c = String(cmd.type || '');
  if (c === 'toggle') {
    execDriver(
      `(() => { const a = document.querySelector('audio');
        if (a) { a.paused ? a.play().catch(()=>{}) : a.pause(); }
        else { const bs=[...document.querySelectorAll('button')];
               const pl=bs.find(b=>/^\s*(play|pause)\s*$/i.test(b.getAttribute('aria-label')||b.title||b.textContent||''));
               if(pl) pl.click(); } })()`
    );
  } else if (c === 'play') {
    execDriver(`(() => { const a=document.querySelector('audio'); if(a) a.play().catch(()=>{}); })()`);
  } else if (c === 'pause') {
    execDriver(`(() => { const a=document.querySelector('audio'); if(a) a.pause(); })()`);
  } else if (c === 'next') {
    execDriver(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Next'); if(b) b.click(); })()`);
  } else if (c === 'prev') {
    execDriver(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Previous'); if(b) b.click(); })()`);
  } else if (c === 'seek') {
    const v = Number(cmd.value || 0);
    execDriver(`(() => { const a=document.querySelector('audio'); if(a) a.currentTime=${v}; })()`);
  } else if (c === 'close-overlay') {
    toggleOverlay();
  }
}

ipcMain.on('overlay:cmd', (_e, cmd) => { runOverlayCmd(cmd); });
ipcMain.on('overlay:ready', () => { startStateTimer(); pushOverlayState().catch(() => {}); });
ipcMain.handle('overlay:ping', () => true);

ipcMain.on('winctl', (_e, action) => {
  if (action === 'overlay') { toggleOverlay(); return; }
  if (!win) return;
  try {
    if (action === 'min') { win.__allowMin = true; win.minimize(); win.__allowMin = false; }
    else if (action === 'max') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
    else if (action === 'close') win.close();
    else if (action === 'mini') {
      if (!win.__mini) {
        win.__prevBounds = win.getBounds();
        win.setSize(420, 190);
        win.setMinimumSize(300, 140);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.__mini = true;
        win.webContents.send('minimode', true);
      } else {
        win.setAlwaysOnTop(false);
        win.setMinimumSize(980, 620);
        if (win.__prevBounds) win.setBounds(win.__prevBounds);
        win.__mini = false;
        win.webContents.send('minimode', false);
      }
    }
  } catch {}
});

ipcMain.handle('updates:check', () => {
  if (!app.isPackaged) return 'dev';
  autoUpdater.checkForUpdates().catch(() => {});
  return 'checking';
});
ipcMain.handle('updates:install', () => {
  try { autoUpdater.quitAndInstall(false, true); } catch {}
});

/* ---------- lifecycle ---------- */
app.whenReady().then(() => {
  createWindow();
  createTray();
  startStateTimer();
  setupUpdater();
  registerHotkeys();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---------- updater ---------- */
function sendUpdate(channel, payload) {
  try { win?.webContents.send('updater', { channel, payload }); } catch {}
}
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('not-available'));
  autoUpdater.on('download-progress', (p) => sendUpdate('progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate('downloaded', { version: info.version }));
  autoUpdater.on('error', (e) => sendUpdate('error', { message: String(e && e.message || e).slice(0, 160) }));
  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 10000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/* ---------- global hotkeys ---------- */
function registerHotkeys() {
  const map = {
    'CommandOrControl+Alt+Right': 'next',
    'CommandOrControl+Alt+Left': 'prev',
    'CommandOrControl+Alt+Space': 'toggle',
    'CommandOrControl+Alt+O': 'overlay',
    // native OS media keys — routed to the renderer's onHotkey handler
    'MediaPlayPause': 'toggle',
    'MediaTrackNext': 'next',
    'MediaTrackPrevious': 'prev',
    'MediaStop': 'pause',
  };
  for (const [accel, action] of Object.entries(map)) {
    try {
      globalShortcut.register(accel, () => {
        if (action === 'overlay') { toggleOverlay(); return; }
        if (action === 'pause') { runOverlayCmd({ type: 'pause' }); return; }
        try { win?.webContents.send('hotkey', action); } catch {}
      });
    } catch { /* some accelerators are unavailable on some platforms */ }
  }
}