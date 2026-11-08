const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { globalShortcut } = require('electron');

let win = null;
let overlay = null;
let backendProc = null;

/* single instance + wicked:// protocol */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.setAsDefaultProtocolClient('wicked');

/* ---------- bundled backend (runs inside Electron's node runtime) ---------- */
function backendDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'wicked-backend');
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

/* ---------- discord rich presence ---------- */
let rpc = null, rpcReady = false, rpcClientId = null;

function dataDir() {
  const d = app.isPackaged ? path.join(process.resourcesPath, 'backend', 'data') : path.join(backendDir(), 'data');
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
function initDiscord() {
  const clientId = getDiscordClientId();
  if (!clientId) return;
  if (rpc && rpcClientId === clientId) return;
  try { if (rpc) { rpc.destroy(); } } catch {}
  rpc = null; rpcReady = false;
  try {
    const { Client } = require('discord-rpc');
    rpc = new Client({ transport: 'ipc' });
    rpc.on('ready', () => { rpcReady = true; console.log('[rpc] discord presence ready'); });
    rpc.login({ clientId }).catch(() => { rpc = null; rpcReady = false; });
    rpcClientId = clientId;
  } catch { rpc = null; rpcReady = false; }
}
function setPresence(track, playing) {
  if (!rpc || !rpcReady) return;
  if (!track || !playing) { rpc.clearActivity().catch(() => {}); return; }
  const activity = {
    details: (track.name || 'Listening').slice(0, 120),
    state: (track.artist || '').slice(0, 120),
    startTimestamp: Math.floor(Date.now() / 1000) - Math.max(0, Math.floor(track.elapsed || 0)),
    largeImageText: (track.album || 'Wicked Player').slice(0, 120),
    instance: false,
  };
  if (track.art && /^https:/.test(track.art)) {
    activity.large_image = track.art;      // album art as the big image
  } else {
    activity.large_image = 'wicked';
  }
  rpc.setActivity(activity).catch(() => {});
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

  win.on('minimize', (e) => {
    if (win.__mini || win.__allowMin) return;
    e.preventDefault();
    win.webContents.send('minimode', true);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => { uiLoaded = true; });
  win.on('closed', () => { win = null; });

  /* load through the backend's login gate */
  ensureBackend().then(() => {
    initDiscord();
    win.loadURL('http://localhost:5000/');
    setTimeout(() => {
      if (!uiLoaded) { try { shell.openExternal('http://localhost:5000'); } catch {} }
    }, 15000);
  });
}

/* ---------- external overlay window (draggable, works over games) ---------- */
function createOverlay() {
  overlay = new BrowserWindow({
    width: 440,
    height: 190,
    minWidth: 300,
    minHeight: 140,
    maxWidth: 900,
    maxHeight: 500,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('http://localhost:5000/?wpoverlay=1');
  overlay.hide();
  overlay.on('closed', () => { overlay = null; });
}
function toggleOverlay() {
  if (!overlay) createOverlay();
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else {
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
  }
}

/* ---------- IPC ---------- */
ipcMain.on('presence', (_e, { track, playing }) => setPresence(track, playing));

/* overlay plumbing */
ipcMain.on('overlay:state', (_e, state) => {
  try { overlay?.webContents.send('overlay:state', state); } catch {}
});
ipcMain.on('overlay:cmd', (_e, cmd) => {
  try { win?.webContents.send('overlay:cmd', cmd); } catch {}
});
ipcMain.on('overlay:ready', () => {
  try { overlay?.webContents.send('overlay:hello', { ok: true }); } catch {}
});
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
  createOverlay();
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
  };
  for (const [accel, action] of Object.entries(map)) {
    globalShortcut.register(accel, () => {
      if (action === 'overlay') { toggleOverlay(); return; }
      try { win?.webContents.send('hotkey', action); } catch {}
    });
  }
}