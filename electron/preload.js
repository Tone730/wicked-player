const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wickedUpdates', {
  // ---- updater ----
  onUpdate: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch {} };
    ipcRenderer.on('updater', handler);
    return () => ipcRenderer.removeListener('updater', handler);
  },
  checkNow: () => ipcRenderer.invoke('updates:check'),
  installNow: () => ipcRenderer.invoke('updates:install'),

  // ---- hotkeys + presence + window controls ----
  onHotkey: (cb) => { const h = (_e, a) => { try { cb(a); } catch {} }; ipcRenderer.on('hotkey', h); return () => ipcRenderer.removeListener('hotkey', h); },
  presence: (track, playing) => ipcRenderer.send('presence', { track, playing }),
  winctl: (a) => ipcRenderer.send('winctl', a),
  onMini: (cb) => { const h = (_e, on) => { try { cb(on); } catch {} }; ipcRenderer.on('minimode', h); return () => ipcRenderer.removeListener('minimode', h); },
  isDesktop: true,

  // ---- external overlay window (works over games / anywhere) ----
  // main window pushes player state; overlay window receives it
  overlayPush: (state) => ipcRenderer.send('overlay:state', state),
  onOverlayState: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch {} };
    ipcRenderer.on('overlay:state', h);
    return () => ipcRenderer.removeListener('overlay:state', h);
  },
  // overlay window sends commands; main window receives them
  overlayCmd: (cmd) => ipcRenderer.send('overlay:cmd', cmd),
  onOverlayCmd: (cb) => {
    const h = (_e, c) => { try { cb(c); } catch {} };
    ipcRenderer.on('overlay:cmd', h);
    return () => ipcRenderer.removeListener('overlay:cmd', h);
  },
  overlayReady: () => ipcRenderer.send('overlay:ready'),
  onOverlayHello: (cb) => {
    const h = (_e, d) => { try { cb(d); } catch {} };
    ipcRenderer.on('overlay:hello', h);
    return () => ipcRenderer.removeListener('overlay:hello', h);
  },
  overlayPing: () => ipcRenderer.invoke('overlay:ping'),
});
