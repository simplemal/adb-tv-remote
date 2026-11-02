'use strict';
const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const { findTool } = require('./binaries');
const { Controller } = require('./controller');
const { scan } = require('./scan');
const { Store } = require('./store');
const { Updates } = require('./updates');

const ADB_DOWNLOAD_PAGE = 'https://developer.android.com/tools/releases/platform-tools';
const FRAME_ACK_TIMEOUT_MS = 2000;
/** Controller methods the page may call. The frequent ones get no reply, and cannot fail. */
const ANSWERED = ['snapshot', 'addDevice', 'selectDevice', 'removeDevice', 'setCommand', 'setLanguage'];
const UNANSWERED = ['key', 'touch', 'text', 'setWatching'];

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
const bundledDir = app.isPackaged
  ? path.join(resources, 'bin')
  : path.join(resources, 'bin', `${process.platform}-${process.arch}`);

let window = null;
let controller = null;
let updates = null;
let closing = false;

/** Sends the newest frame only: a slow window skips frames instead of falling behind. */
class FrameSender {
  constructor() {
    this.next = null;
    this.waiting = false;
    this.timer = null;
  }

  send(data, kind) {
    this.next = { data, kind };
    this.flush();
  }

  flush() {
    if (this.waiting || !this.next || !window || window.isDestroyed()) return;
    window.webContents.send('screen:frame', this.next);
    this.next = null;
    this.waiting = true;
    this.timer = setTimeout(() => this.shown(), FRAME_ACK_TIMEOUT_MS);
  }

  shown() {
    clearTimeout(this.timer);
    this.waiting = false;
    this.flush();
  }
}

const frames = new FrameSender();

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: app.name,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('did-finish-load', () => frames.shown());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** Calls from anything but our own main frame are ignored. */
const fromPage = event => event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame;

function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => (fromPage(event) ? listener(...args) : undefined));
}

function listen(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromPage(event)) listener(...args);
  });
}

function connectPage() {
  for (const name of ANSWERED) handle(name, (...args) => controller[name](...args));
  for (const name of UNANSWERED) listen(name, (...args) => controller[name](...args));
  handle('findDevices', () => scan());
  handle('openAdbHelp', () => shell.openExternal(ADB_DOWNLOAD_PAGE));
  listen('frameShown', () => frames.shown());
  listen('installUpdate', installUpdate);
  controller.on('state', state => window?.webContents.send('state', state));
  controller.on('frame', (data, kind) => frames.send(data, kind));
  controller.on('echo', (key, down) => window?.webContents.send('key:echo', key, down));
}

/** Only a packaged app has anything to replace: `npm start` runs from the source. */
function watchUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  updates = new Updates({
    updater: autoUpdater,
    onReady: version => window?.webContents.send('update:ready', version),
  });
  updates.start();
}

function installUpdate() {
  if (!updates?.version || closing) return;
  closing = true;
  updates.stop();
  controller.shutdown().finally(() => updates.updater.quitAndInstall());
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function start() {
  app.setAboutPanelOptions({
    credits: 'Uses FFmpeg under the LGPL 2.1 (source: https://ffmpeg.org/releases/) and Android adb under the Apache License 2.0. See THIRD_PARTY_NOTICES.md.',
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  buildMenu();
  controller = new Controller({
    adbPath: findTool('adb', { bundledDir }),
    ffmpegPath: findTool('ffmpeg', { bundledDir }),
    dexPath: path.join(resources, 'keyinput', 'keyinput.dex'),
    store: new Store(path.join(app.getPath('userData'), 'config.json')),
  });
  connectPage();
  createWindow();
  controller.poll();
  watchUpdates();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', event => {
    if (closing || !controller) return;
    closing = true;
    event.preventDefault();
    controller.shutdown().finally(() => app.exit(0));
  });
  app.whenReady().then(start);
}
