'use strict';
const { EventEmitter } = require('node:events');
const { Adb, LONG_TIMEOUT_MS, isValidAddress, target } = require('./adb');
const { KeyInjector } = require('./injector');
const { KEYS, isValidCommand, textCommand } = require('./keys');
const { ScreenCapture } = require('./screen');
const { KeyEcho } = require('./echo');

const POLL_MS = 5000;
const POLL_WAITING_MS = 2000;
const POLL_ASLEEP_MS = 15000;
const POLL_FAILED_MS = 30000;
const POLL_AFTER_KEY_MS = 1000;
/** Longer than any wait between polls of a working device, so keys need not wait for a check. */
const STATUS_FRESH_MS = POLL_ASLEEP_MS + POLL_MS;
const MAX_QUEUED = 16;
const COMMANDS = new Set(['menuHold', 'homeCommand']);
const LANGUAGES = new Set(['auto', 'en', 'it']);
const TOUCH_ACTIONS = new Set(['down', 'move', 'up']);
const FALLBACK_SIZE = { width: 1920, height: 1080 };
const POWER_STEP_MS = 500;
const POWER_STEP_LIMIT_MS = 2000;
const POWER_WAIT_MS = 20000;
const PICTURE_WAIT_MS = 3000;
const POWER_COMMAND = 'dumpsys power | grep -m1 mWakefulness=';

const isFraction = value => typeof value === 'number' && value >= 0 && value <= 1;

/** Everything the app does with a device. Knows nothing about Electron. */
class Controller extends EventEmitter {
  constructor({ adbPath, ffmpegPath, dexPath, store, serverPort }) {
    super();
    this.store = store;
    this.adb = adbPath ? new Adb({ path: adbPath, serverPort }) : null;
    this.ffmpegPath = ffmpegPath;
    this.injector = this.adb ? new KeyInjector({ adb: this.adb, dexPath }) : null;
    this.capture = this.adb ? new ScreenCapture({
      adb: this.adb,
      ffmpegPath,
      connectedTarget: () => this.connectedTarget(),
      knownTarget: () => this.knownTarget(),
      quickShot: async name => (await this.injector.ready(name) ? this.injector.shot() : null),
      publish: (data, kind) => {
        this.frameAt = Date.now();
        this.emit('frame', data, kind);
      },
    }) : null;
    this.echo = this.adb ? new KeyEcho({
      adb: this.adb,
      knownTarget: () => this.knownTarget(),
      publish: (key, down) => {
        // The key may come from another remote: the video would still show the step before.
        if (down) this.capture.noteKey();
        this.emit('echo', key, down);
      },
    }) : null;
    this.status = 'connecting';
    this.reason = '';
    this.statusAt = 0;
    this.power = 'awake';
    this.powerTimer = null;
    this.reading = null;
    this.awakeAt = 0;
    this.frameAt = 0;
    this.checking = null;
    this.pollTimer = null;
    this.failedPolls = 0;
    this.nameAsked = '';
    this.queue = Promise.resolve();
    this.queued = 0;
    this.size = null;
    this.visible = false;
    this.stopped = false;
    this.serverReady = this.adb?.startServer();
  }

  snapshot() {
    return {
      status: this.status,
      reason: this.reason,
      power: this.power,
      selected: this.store.selected?.address ?? '',
      devices: this.store.devices.map(device => ({ ...device })),
      language: this.store.language,
      smoothVideo: Boolean(this.ffmpegPath),
    };
  }

  announce() {
    this.emit('state', this.snapshot());
  }

  setStatus(status) {
    this.statusAt = Date.now();
    if (status !== this.status) {
      this.status = status;
      if (status === 'connected') {
        this.capture?.restart();
        this.echo?.restart();
      }
      this.announce();
    }
  }

  setPower(power) {
    if (power !== this.power) {
      this.power = power;
      this.updateCapture();
      this.announce();
    }
  }

  /** The picture runs while someone can see it and the device has one to show. A recording
   *  started before the device is awake stays black for good, even once the screen is back. */
  updateCapture() {
    const stillAsleep = this.power === 'asleep' || (this.power === 'waking' && !this.awakeAt);
    this.capture?.setWatching(this.visible && !stillAsleep);
    this.echo?.setWatching(this.visible && !stillAsleep);
  }

  /** "awake", "asleep", or null if the device did not say. Dreaming is the screensaver: the
   *  device is on, and a key brings it back at once. */
  async wakefulness(name) {
    const { text } = await this.adb.shell(name, POWER_COMMAND);
    if (!text.includes('mWakefulness=')) return null;
    return /mWakefulness=(Asleep|Dozing)/.test(text) ? 'asleep' : 'awake';
  }

  /** Reads the real state. Calls made while a read is running share its answer. */
  readPower() {
    this.reading ??= this.askPower().finally(() => { this.reading = null; });
    return this.reading;
  }

  /** While waking, "awake" waits for the picture: that is what people see. */
  async askPower() {
    const address = this.store.selected?.address;
    if (!address) return;
    const state = await this.wakefulness(target(address));
    if (!state || this.store.selected?.address !== address) return;
    if (this.power === 'sleeping' && state === 'awake') return;
    if (this.power !== 'waking') {
      this.setPower(state);
    } else if (state === 'awake') {
      if (!this.awakeAt) {
        this.awakeAt = Date.now();
        this.updateCapture();
        this.capture?.noteKey(true);
      }
      this.awaitPicture();
    }
  }

  awaitPicture() {
    if (this.frameAt > this.awakeAt || Date.now() - this.awakeAt > PICTURE_WAIT_MS) this.setPower('awake');
  }

  /** Follows a power key closely, because waking takes seconds and the screen stays black. */
  followPower(power) {
    clearTimeout(this.powerTimer);
    this.awakeAt = 0;
    this.setPower(power);
    const until = Date.now() + POWER_WAIT_MS;
    let wait = POWER_STEP_MS;
    const step = async () => {
      // Once the device is awake only the picture is missing, and that takes no question.
      if (this.awakeAt) this.awaitPicture();
      else await this.readPower().catch(() => {});
      if (this.power !== power || this.stopped) return;
      if (Date.now() < until) {
        wait = this.awakeAt ? POWER_STEP_MS : Math.min(wait * 2, POWER_STEP_LIMIT_MS);
        this.powerTimer = setTimeout(step, wait);
      } else {
        this.setPower(power === 'waking' ? 'awake' : 'asleep');
      }
    };
    this.powerTimer = setTimeout(step, POWER_STEP_MS);
  }

  /** How long until the next check: longer for a device that sleeps or does not answer. */
  pollDelay() {
    if (this.status === 'unauthorized') return POLL_WAITING_MS;
    if (this.status !== 'connected') {
      const delay = Math.min(POLL_MS * 2 ** this.failedPolls, POLL_FAILED_MS);
      this.failedPolls += 1;
      return delay;
    }
    this.failedPolls = 0;
    return this.power === 'asleep' ? POLL_ASLEEP_MS : POLL_MS;
  }

  /** Checks now, and keeps checking while the window can be seen. */
  async poll() {
    await this.refresh().catch(() => {});
    clearTimeout(this.pollTimer);
    if (!this.stopped && this.visible) this.pollTimer = setTimeout(() => this.poll(), this.pollDelay());
  }

  /** A key can wake the device, so a sleeping one is asked without waiting its turn. */
  pollSoon() {
    clearTimeout(this.pollTimer);
    if (!this.stopped && this.visible) this.pollTimer = setTimeout(() => this.poll(), POLL_AFTER_KEY_MS);
  }

  /** Checks the selected device. Calls made while a check is running share its answer. */
  refresh() {
    this.checking ??= this.check().finally(() => { this.checking = null; });
    return this.checking;
  }

  /** While a power key is followed its own loop asks, and a recent frame proves the device is on. */
  powerIsKnown() {
    if (this.power === 'waking' || this.power === 'sleeping') return true;
    return this.power === 'awake' && Date.now() - this.frameAt < POLL_MS;
  }

  async check() {
    if (!this.adb) return this.setStatus('no-adb');
    await this.serverReady;
    const address = this.store.selected?.address;
    if (!address) return this.setStatus('no-device');
    const status = await this.adb.connect(address);
    if (this.stopped) return;
    if (this.store.selected?.address !== address) return this.check(); // The user moved on meanwhile.
    const reasonChanged = this.adb.reason !== this.reason;
    this.reason = this.adb.reason;
    this.setStatus(status);
    if (reasonChanged) this.announce();
    if (status !== 'connected') return;
    // Not awaited: a key waiting for this check must not wait for the device's power as well.
    if (!this.powerIsKnown()) this.readPower().catch(() => {});
    const device = this.store.selected;
    if (device?.address === address && !device.name && this.nameAsked !== address) {
      this.nameAsked = address;
      const name = await this.adb.deviceName(address);
      if (name) {
        this.store.rename(address, name);
        this.announce();
      }
    }
  }

  /** adb's name for the selected device if the last check found it connected. Asks nothing. */
  knownTarget() {
    const address = this.store.selected?.address;
    return this.status === 'connected' && address ? target(address) : null;
  }

  /** adb's name for the selected device if it is connected, otherwise null. */
  async connectedTarget() {
    if (this.status !== 'connected' || Date.now() - this.statusAt > STATUS_FRESH_MS) await this.refresh();
    return this.knownTarget();
  }

  /** Runs jobs one at a time, so keys arrive in order. Excess keys are dropped, not delayed. */
  enqueue(job, always = false) {
    if (this.queued >= MAX_QUEUED && !always) return;
    this.queued += 1;
    this.queue = this.queue.then(job).catch(() => {}).finally(() => { this.queued -= 1; });
  }

  /** Runs `action` on the helper. False if it could not, and the caller takes the slow way. */
  async inject(name, action) {
    try {
      if (!await this.injector.ready(name)) return false;
      await action();
      return true;
    } catch {
      this.injector.close();
      return false;
    }
  }

  /** Fire OS ignores an injected POWER, and SLEEP and WAKEUP work everywhere, so pick by state. */
  async powerKey(name) {
    const state = await this.wakefulness(name) ?? this.power;
    return state === 'asleep' || state === 'sleeping' ? 'WAKEUP' : 'SLEEP';
  }

  async sendKey(key, longPress) {
    const name = await this.connectedTarget();
    if (!name) return;
    const code = key === 'POWER' ? await this.powerKey(name) : key;
    if (key === 'POWER') this.followPower(code === 'SLEEP' ? 'sleeping' : 'waking');
    if (await this.inject(name, () => this.injector.key(code, longPress))) return;
    await this.adb.shell(name, `input keyevent ${longPress ? '--longpress ' : ''}${code}`,
      { timeout: LONG_TIMEOUT_MS });
  }

  key(key, longPress) {
    if (!this.adb || !KEYS.has(key)) return;
    this.capture.noteKey();
    // Injected keys never reach accessibility services, so a shortcut on a held key needs this.
    const device = this.store.selected;
    const command = (key === 'MENU' && longPress && device?.menuHold)
      || (key === 'HOME' && !longPress && device?.homeCommand);
    if (command) this.enqueue(() => this.runCommand(command));
    else this.enqueue(() => this.sendKey(key, Boolean(longPress)));
    if (this.power === 'asleep') this.pollSoon();
  }

  async runCommand(command) {
    const name = await this.connectedTarget();
    if (name) await this.adb.shell(name, command, { timeout: LONG_TIMEOUT_MS });
  }

  setCommand(field, command) {
    const address = this.store.selected?.address;
    if (!address || !COMMANDS.has(field) || !isValidCommand(command)) return;
    this.store.setCommand(address, field, command.trim());
    this.announce();
  }

  /** The screen in pixels. An override, listed last, is what touches are measured against. */
  async displaySize(name) {
    if (this.size) return this.size;
    const { text } = await this.adb.shell(name, 'wm size');
    const sizes = [...text.matchAll(/(\d+)x(\d+)/g)];
    const last = sizes.at(-1);
    if (!last) return FALLBACK_SIZE;
    this.size = { width: Number(last[1]), height: Number(last[2]) };
    return this.size;
  }

  async sendTouch(action, x, y) {
    const name = await this.connectedTarget();
    if (!name) return;
    const { width, height } = await this.displaySize(name);
    const pixelX = Math.round(x * (width - 1));
    const pixelY = Math.round(y * (height - 1));
    if (await this.inject(name, () => this.injector.touch(action, pixelX, pixelY))) return;
    if (action === 'up') {
      await this.adb.shell(name, `input tap ${pixelX} ${pixelY}`, { timeout: LONG_TIMEOUT_MS });
    }
  }

  /** x and y are fractions of the picture. A lost move does no harm; a lost release would. */
  touch(action, x, y) {
    if (!this.adb || !TOUCH_ACTIONS.has(action) || !isFraction(x) || !isFraction(y)) return;
    if (action === 'move' && this.queued > 1) return;
    if (action !== 'move') this.capture.noteKey(true);
    this.enqueue(() => this.sendTouch(action, x, y), action !== 'move');
  }

  text(text) {
    const command = textCommand(text);
    if (!this.adb || !command) return;
    this.capture.noteKey();
    this.enqueue(() => this.runCommand(command));
  }

  /** The selected device changed: drop what was running on the old one, and what we knew of it. */
  deviceChanged() {
    this.injector?.reset();
    clearTimeout(this.powerTimer);
    this.size = null;
    this.power = 'awake';
    this.awakeAt = 0;
    this.frameAt = 0;
    this.failedPolls = 0;
    this.nameAsked = '';
    this.status = this.store.selected ? 'connecting' : 'no-device';
    this.reason = '';
    this.statusAt = 0;
    this.announce();
    this.capture?.restart();
    this.echo?.restart();
    this.updateCapture();
    this.poll();
  }

  addDevice(address) {
    const clean = typeof address === 'string' ? address.trim() : '';
    if (!isValidAddress(clean)) return false;
    this.store.add(clean);
    this.deviceChanged();
    return true;
  }

  selectDevice(address) {
    if (!this.store.select(address)) return false;
    this.deviceChanged();
    return true;
  }

  removeDevice(address) {
    if (!this.store.find(address)) return;
    const wasSelected = this.store.selected?.address === address;
    this.store.remove(address);
    this.adb?.run(['disconnect', target(address)]);
    if (wasSelected) this.deviceChanged();
    else this.announce();
  }

  setLanguage(language) {
    if (!LANGUAGES.has(language)) return;
    this.store.language = language;
    this.announce();
  }

  /** Whether the window can be seen. While it cannot, nothing asks the device anything: it is
   *  checked again the moment the window comes back. */
  setWatching(visible) {
    if (this.stopped) return;
    this.visible = visible === true;
    this.updateCapture();
    clearTimeout(this.pollTimer);
    if (this.visible) this.poll();
  }

  /** Leaves nothing running: the helper dies with its connection, and the server is ours. */
  async shutdown() {
    this.stopped = true;
    this.visible = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.powerTimer);
    this.capture?.setWatching(false);
    this.echo?.setWatching(false);
    this.injector?.close();
    await this.adb?.close();
  }
}

module.exports = { Controller };
