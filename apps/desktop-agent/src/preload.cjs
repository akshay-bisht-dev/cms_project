// The status window gets a narrow, explicit API; it has no Node.js access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbit', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  pair: (serverUrl, code) => ipcRenderer.invoke('pair', { serverUrl, code }),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  requestPermission: () => ipcRenderer.invoke('permission:request'),
  openPermissionSettings: () => ipcRenderer.invoke('permission:open'),
  openMonitoringPage: () => ipcRenderer.invoke('open:monitoring'),
  getPreferences: () => ipcRenderer.invoke('prefs:get'),
  setPreference: (name, value) => ipcRenderer.invoke('prefs:set', { name, value }),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
});
