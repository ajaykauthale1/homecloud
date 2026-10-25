const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('homecloud', {
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  getMedia: (params) => ipcRenderer.invoke('get-media', params),
  chooseStorageFolder: () => ipcRenderer.invoke('choose-storage-folder'),
  setStorageFolderPath: (customPath) => ipcRenderer.invoke('set-storage-folder-path', customPath),
  openStorageFolder: () => ipcRenderer.invoke('open-storage-folder'),
  revealMediaInFolder: (relativePath) => ipcRenderer.invoke('reveal-media-in-folder', relativePath),
  toggleFavorite: (id) => ipcRenderer.invoke('toggle-favorite', id),
  setOrganizeByDate: (enabled) => ipcRenderer.invoke('set-organize-by-date', enabled),
  setOrganizeByDevice: (enabled) => ipcRenderer.invoke('set-organize-by-device', enabled),
  setProtectFromPhoneDelete: (enabled) => ipcRenderer.invoke('set-protect-from-phone-delete', enabled),
  rescanFolder: () => ipcRenderer.invoke('rescan-folder'),
  onServerEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('server-event', handler);
    return () => ipcRenderer.removeListener('server-event', handler);
  }
});
