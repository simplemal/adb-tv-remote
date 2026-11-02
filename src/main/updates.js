'use strict';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * New versions come from this repository's GitHub releases. They download by themselves, and
 * install only when the person says so: the app may be in the middle of driving a TV.
 */
class Updates {
  constructor({ updater, onReady }) {
    this.updater = updater;
    this.timer = null;
    this.version = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.on('update-downloaded', ({ version }) => {
      this.version = version;
      onReady(version);
    });
    // No network, or no release for this system: nothing the person can act on.
    updater.on('error', () => {});
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  check() {
    // One already downloaded stays offered: there is nothing to ask until it is installed.
    if (!this.version) this.updater.checkForUpdates()?.catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Updates };
