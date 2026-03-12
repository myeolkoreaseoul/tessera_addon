const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiwi', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
});
