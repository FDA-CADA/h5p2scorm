'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  convert: (args) => ipcRenderer.invoke('convert', args),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  pathOf: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p))
});
