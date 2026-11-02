'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ask = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const tell = channel => (...args) => ipcRenderer.send(channel, ...args);

/** The only things the page can do. There is no general channel, and no Node.js. */
contextBridge.exposeInMainWorld('tvRemote', {
  getState: ask('snapshot'),
  addDevice: ask('addDevice'),
  selectDevice: ask('selectDevice'),
  removeDevice: ask('removeDevice'),
  findDevices: ask('findDevices'),
  setCommand: ask('setCommand'),
  setLanguage: ask('setLanguage'),
  openAdbHelp: ask('openAdbHelp'),
  installUpdate: tell('installUpdate'),
  sendKey: tell('key'),
  sendTouch: tell('touch'),
  sendText: tell('text'),
  setVisible: tell('setWatching'),
  frameShown: tell('frameShown'),
  onState: listener => ipcRenderer.on('state', (_event, state) => listener(state)),
  onFrame: listener => ipcRenderer.on('screen:frame', (_event, frame) => listener(frame)),
  onUpdateReady: listener => ipcRenderer.on('update:ready', (_event, version) => listener(version)),
  onKeyEcho: listener => ipcRenderer.on('key:echo', (_event, key, down) => listener(key, down)),
});
