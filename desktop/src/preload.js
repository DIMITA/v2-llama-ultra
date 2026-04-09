'use strict';

/**
 * preload.js
 * Exposes a safe, typed API to the renderer via contextBridge.
 * Never expose Node.js directly — always go through this bridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('llamaUltra', {
  // ── Store ──────────────────────────────────────────────────────────────
  store: {
    get:    (key)         => ipcRenderer.invoke('store:get', key),
    set:    (key, value)  => ipcRenderer.invoke('store:set', key, value),
    getAll: ()            => ipcRenderer.invoke('store:getAll'),
  },

  // ── File dialogs ───────────────────────────────────────────────────────
  dialog: {
    openModel: () => ipcRenderer.invoke('dialog:openModel'),
    openDir:   () => ipcRenderer.invoke('dialog:openDir'),
  },

  // ── Hardware ───────────────────────────────────────────────────────────
  hw: {
    detect: () => ipcRenderer.invoke('hw:detect'),
  },

  // ── Shell ──────────────────────────────────────────────────────────────
  shell: {
    openPath: (p)   => ipcRenderer.invoke('shell:openPath', p),
    openUrl:  (url) => ipcRenderer.invoke('shell:openUrl', url),
  },

  // ── Events from main ───────────────────────────────────────────────────
  on: (channel, fn) => {
    const allowed = ['navigate', 'trigger', 'engine:event'];
    if (!allowed.includes(channel)) return;
    const sub = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },

  // ── Migration ──────────────────────────────────────────────────────────
  migrate: {
    scan: (extraDirs)       => ipcRenderer.invoke('migrate:scan', extraDirs ?? []),
    run:  (models, mode)    => ipcRenderer.invoke('migrate:run',  models, mode),
  },

  // ── Platform info ──────────────────────────────────────────────────────
  platform: process.platform,
  version:  process.env.npm_package_version ?? '1.0.0',
});
