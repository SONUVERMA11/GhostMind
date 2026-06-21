const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghostAPI', {
  // Config & environment
  getConfig:   ()        => ipcRenderer.invoke('get-config'),
  getEnv:      (key)     => ipcRenderer.invoke('get-env', key),

  // Window controls
  resizeWindow: (w, h)   => ipcRenderer.send('resize-window', { width: w, height: h }),
  setOpacity:   (val)    => ipcRenderer.send('set-opacity', val),
  quit:         ()       => ipcRenderer.send('quit-app'),

  // Proxy server controls (Antigravity credits)
  proxyHealth:  ()       => ipcRenderer.invoke('proxy-health'),
  proxySetKey:  (key)    => ipcRenderer.invoke('proxy-set-key', key),

  // Hotkey events from main process
  onHotkey:    (cb)      => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  removeHotkeyListeners: () => ipcRenderer.removeAllListeners('hotkey'),
});
