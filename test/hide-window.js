'use strict';
/** Loaded into the app under test: it still draws, but nothing shows up on the screen of whoever runs the tests. */
const { app, BrowserWindow } = require('electron');

app.dock?.hide();
app.on('browser-window-created', (_, window) => {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.show = () => BrowserWindow.prototype.showInactive.call(window);
});
