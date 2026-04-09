'use strict';

/**
 * main.js — Electron main process
 * Creates the app window, sets up IPC handlers, manages the engine subprocess.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path  = require('path');
const os    = require('os');
const Store = require('electron-store');

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

// ─── Persistent store ─────────────────────────────────────────────────────────

const store = new Store({
  defaults: {
    modelsDir:      path.join(os.homedir(), '.llama-ultra', 'models'),
    quantization:   'auto',
    pricingEnabled: true,
    maxCacheSizeMb: 2048,
    enableGPU:      true,
    windowBounds:   { width: 1200, height: 800 },
    theme:          'dark',
  },
});

// ─── Window management ────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width, height,
    minWidth:  900,
    minHeight: 620,
    title:     'LLaMA Ultra',
    icon:      path.join(__dirname, '../assets/icon.png'),
    show:      false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration:    false,
      contextIsolation:   true,
      sandbox:            true,
      preload:            path.join(__dirname, 'preload.js'),
    },
  });

  // Load the UI
  const indexPath = isDev
    ? `http://localhost:5173`  // Vite dev server
    : path.join(__dirname, '../public/index.html');

  if (isDev) {
    mainWindow.loadURL(indexPath);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(indexPath.replace('file://', ''));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.focus();
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowBounds', { width: w, height: h });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('ready', () => {
  createWindow();
  setupMenu();
  setupTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: Settings ────────────────────────────────────────────────────────────

ipcMain.handle('store:get', (_e, key)        => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('store:getAll', ()            => store.store);

// ─── IPC: File dialogs ────────────────────────────────────────────────────────

ipcMain.handle('dialog:openModel', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:       'Select a model file',
    defaultPath: store.get('modelsDir'),
    filters:     [{ name: 'GGUF Models', extensions: ['gguf', 'bin', 'ggml'] }],
    properties:  ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Select models directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Hardware detection ─────────────────────────────────────────────────

ipcMain.handle('hw:detect', async () => {
  try {
    const si = require('systeminformation');
    const [cpu, mem, graphics] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.graphics(),
    ]);
    return {
      cpu:     { model: `${cpu.manufacturer} ${cpu.brand}`, cores: cpu.cores, speed: cpu.speed },
      ram:     { totalGb: +(mem.total / 1024**3).toFixed(2), freeGb: +(mem.free / 1024**3).toFixed(2) },
      gpu:     graphics.controllers[0] ?? null,
      os:      { platform: process.platform, arch: process.arch },
    };
  } catch {
    return { cpu: {}, ram: {}, gpu: null, os: { platform: process.platform, arch: process.arch } };
  }
});

// ─── IPC: Shell open ─────────────────────────────────────────────────────────

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openUrl',  (_e, url) => shell.openExternal(url));

// ─── Menu ─────────────────────────────────────────────────────────────────────

function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('navigate', '/settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Model…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('trigger', 'openModel') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/dimita/v2-llama-ultra') },
        { label: 'Report Issue',  click: () => shell.openExternal('https://github.com/dimita/v2-llama-ultra/issues') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

let tray = null;
function setupTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray-icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('LLaMA Ultra');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (_) {
    // Tray icon not available in dev without icon file
  }
}
