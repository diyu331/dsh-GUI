'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  // 启动画面
  onStatus: (cb) => { ipcRenderer.on('dsh:status', (_e, s) => cb(s)); },
  getBootstrap: () => ipcRenderer.invoke('dsh:bootstrap'),
  hideToTray: () => ipcRenderer.invoke('dsh:hide-to-tray'),
  retryBoot: () => ipcRenderer.invoke('dsh:retry-boot'),
  quit: () => ipcRenderer.invoke('dsh:quit'),
  // 引擎更新
  onUpdateEvent: (cb) => { ipcRenderer.on('dsh:update-event', (_e, s) => cb(s)); },
  engineApply: (v) => ipcRenderer.invoke('dsh:engine-apply', v),
});
