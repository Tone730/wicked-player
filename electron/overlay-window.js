'use strict';
/* Wicked Player - overlay window manager (persisted, tray-connected).
   Extracted from main.js to keep the overlay logic in one place.
   The pure helpers in overlay-state.js are unit-tested. */
const { BrowserWindow, screen, Tray, Menu, ipcMain, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const stateMod = require('./overlay-state.js');

let overlay = null;
let tray = null;
let stateTimer = null;
let saveTimer = null;
let settings = stateMod.mergeOverlaySettings(null);
let lastPresenceAt = 0;
let onOverlayCmd = null;      // set by main.js: (cmd) => void
let readPlayerState = null;   // set by main.js: () => Promise<state|null>
let isQuitting = false;

function settingsFile() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'overlay-settings.json');
}
function loadSettings() {
  try { settings = stateMod.mergeOverlaySettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch { settings = stateMod.mergeOverlaySettings(null); }
}
function saveSettingsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
  }, 400);
}

function createOverlayWindow(create) {
  loadSettings();
  const b = settings.bounds ? stateMod.clampBounds(settings.bounds, screen.getAllDisplays()) : null;
  const compact = settings.compact;
  overlay = new BrowserWindow({
    width: b ? b.width : (compact ? 360 : 440),
    height: b ? b.height : (compact ? 84 : 190),
    minWidth: 280,
    minHeight: compact ? 64 : 140,
    maxWidth: 900,
    maxHeight: 500,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    title: 'Wicked Player - Overlay',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // persist position/size as the user drags/resizes (debounced)
  const persist = () => {
    if (!overlay || overlay.isDestroyed()) return;
    settings.bounds = overlay.getBounds();
    saveSettingsSoon();
  };
  overlay.on('moved', persist);
  overlay.on('resized', persist);

  overlay.on('closed', () => { overlay = null; stopStateTimer(); });
  overlay.webContents.on('did-finish-load', () => {
    // push settings (skin/compact/volume) into the overlay UI
    try { overlay.webContents.send('overlay:settings', { skin: settings.skin, compact: settings.compact, volume: settings.volume }); } catch {}
  });

  if (create) create(overlay);
  return overlay;
}

function showOverlay() {
  if (!overlay || overlay.isDestroyed()) createOverlayWindow(null);
  const show = () => {
    try {
      overlay.show();
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
      startStateTimer();
    } catch {}
  };
  overlay.loadURL('http://localhost:5000/?wpoverlay=1&t=' + Date.now()).then(show).catch(show);
}

function hideOverlay() {
  if (overlay && overlay.isVisible()) overlay.hide();
  stopStateTimer();
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) { hideOverlay(); return; }
  showOverlay();
}

function startStateTimer() {
  if (stateTimer) return;
  stateTimer = setInterval(() => { pushOverlayState().catch(() => {}); }, 500);
}
function stopStateTimer() {
  if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
}

async function pushOverlayState() {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible() || !readPlayerState) return;
  const raw = await readPlayerState();
  // no raw state = main window gone/crashed -> disconnected state, controls disabled
  const st = stateMod.sanitizePlayerState(raw);
  try { overlay.webContents.send('overlay:state', st); } catch {}
  if (raw && st.title && Date.now() - lastPresenceAt > 2000) {
    lastPresenceAt = Date.now();
    try { onPresenceHook(st.title, st.artist, st.art, st.pos, st.playing); } catch {}
  }
}
let onPresenceHook = () => {};

/* ---------- tray ---------- */
function ensureTray(hooks) {
  if (tray || !Tray) return;
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Wicked Player');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Player', click: () => { try { hooks.showPlayer(); } catch {} } },
    { label: 'Show/Hide Overlay', click: () => toggleOverlay() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; hooks.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { try { hooks.showPlayer(); } catch {} });
}

/* ---------- display changes: keep overlay on-screen ---------- */
function repositionOnDisplayChange() {
  if (!overlay || overlay.isDestroyed() || !settings.bounds) return;
  const clamped = stateMod.clampBounds(settings.bounds, screen.getAllDisplays());
  overlay.setBounds(clamped);
  settings.bounds = clamped;
  saveSettingsSoon();
}

/* ---------- wiring called by main.js ---------- */
function initOverlaySystem(opts) {
  onOverlayCmd = opts.onCommand;
  onPresenceHook = opts.onPresence;
  readPlayerState = opts.readState;
  loadSettings();
  ensureTray(opts.trayHooks);
  screen.on('display-removed', repositionOnDisplayChange);
  screen.on('display-metrics-changed', repositionOnDisplayChange);

  ipcMain.on('overlay:cmd', (_e, cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'ui') {
      // overlay UI prefs (skin/compact) -> persist across launches
      if (typeof cmd.skin === 'string') settings.skin = cmd.skin;
      if (typeof cmd.compact === 'boolean') settings.compact = cmd.compact;
      saveSettingsSoon();
      return;
    }
    if (cmd.type === 'volume' && typeof cmd.value === 'number') {
      settings.volume = Math.min(1, Math.max(0, cmd.value));
      saveSettingsSoon();
    }
    opts.onCommand(cmd);
  });
  ipcMain.on('overlay:ready', () => {
    try { overlay.webContents.send('overlay:settings', { skin: settings.skin, compact: settings.compact, volume: settings.volume }); } catch {}
    startStateTimer();
  });
  ipcMain.handle('overlay:ping', () => true);
}

function shutdownOverlay() {
  isQuitting = true;
  stopStateTimer();
  if (saveTimer) { clearTimeout(saveTimer); try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} }
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
}

module.exports = {
  initOverlaySystem: initOverlaySystem,
  toggleOverlay: toggleOverlay,
  showOverlay: showOverlay,
  hideOverlay: hideOverlay,
  shutdownOverlay: shutdownOverlay,
  getOverlayVisible: function () { return !!(overlay && overlay.isVisible()); },
  getSettings: function () { return settings; },
  get isQuitting() { return isQuitting; },
};