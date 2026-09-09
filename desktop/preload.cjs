const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idelDesktop', {
  chooseWorkspace: () => ipcRenderer.invoke('idel:choose-workspace'),
});
