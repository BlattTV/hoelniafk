const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  info: () => ipcRenderer.invoke('info'),
  login: (username, password, name, trustFingerprint) => ipcRenderer.invoke('login', { username, password, name, trustFingerprint }),
  logout: () => ipcRenderer.invoke('logout'),
  pause: () => ipcRenderer.invoke('pause'),
  resume: () => ipcRenderer.invoke('resume'),
  changeBackend: (url, adminUser, adminPassword) => ipcRenderer.invoke('change-backend', { url, adminUser, adminPassword }),
  setProxy: (proxy) => ipcRenderer.invoke('set-proxy', { proxy }),
  setAutostart: (on) => ipcRenderer.invoke('autostart', { on }),
  onStatus: (fn) => ipcRenderer.on('status', (_e, s) => fn(s)),
});
