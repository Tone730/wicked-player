const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wickedUpdates', {
  onUpdate: function (cb) {
    var handler = function (_e, data) { try { cb(data); } catch (e) {} };
    ipcRenderer.on('updater', handler);
    return function () { ipcRenderer.removeListener('updater', handler); };
  },
  checkNow: function () { return ipcRenderer.invoke('updates:check'); },
  installNow: function () { return ipcRenderer.invoke('updates:install'); },
  onHotkey: function (cb) {
    var h = function (_e, a) { try { cb(a); } catch (e) {} };
    ipcRenderer.on('hotkey', h);
    return function () { ipcRenderer.removeListener('hotkey', h); };
  },
  presence: function (track, playing) { ipcRenderer.send('presence', { track: track, playing: playing }); },
  presenceConfig: function (cfg) { ipcRenderer.send('presence:config', cfg); },
  setPresenceEnabled: function (on) { ipcRenderer.send('presence:enabled', !!on); },
  getPresenceStatus: function () { return ipcRenderer.invoke('presence:status'); },
  winctl: function (a) { ipcRenderer.send('winctl', a); },
  onMini: function (cb) {
    var h = function (_e, on) { try { cb(on); } catch (e) {} };
    ipcRenderer.on('minimode', h);
    return function () { ipcRenderer.removeListener('minimode', h); };
  },
  isDesktop: true,
  overlayPush: function (state) { ipcRenderer.send('overlay:state', state); },
  onOverlayState: function (cb) {
    var h = function (_e, s) { try { cb(s); } catch (e) {} };
    ipcRenderer.on('overlay:state', h);
    return function () { ipcRenderer.removeListener('overlay:state', h); };
  },
  overlayCmd: function (cmd) { ipcRenderer.send('overlay:cmd', cmd); },
  onOverlayCmd: function (cb) {
    var h = function (_e, c) { try { cb(c); } catch (e) {} };
    ipcRenderer.on('overlay:cmd', h);
    return function () { ipcRenderer.removeListener('overlay:cmd', h); };
  },
  overlayReady: function () { ipcRenderer.send('overlay:ready'); },
  onOverlayHello: function (cb) {
    var h = function (_e, d) { try { cb(d); } catch (e) {} };
    ipcRenderer.on('overlay:hello', h);
    return function () { ipcRenderer.removeListener('overlay:hello', h); };
  },
  onOverlaySettings: function (cb) {
    var h = function (_e, d) { try { cb(d); } catch (e) {} };
    ipcRenderer.on('overlay:settings', h);
    return function () { ipcRenderer.removeListener('overlay:settings', h); };
  },
});
