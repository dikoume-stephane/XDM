const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  read: () => ipcRenderer.invoke('vault:read')
});
