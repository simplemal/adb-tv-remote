'use strict';
const { LONG_TIMEOUT_MS } = require('./adb');

const REMOTE_PATH = '/data/local/tmp/adb-tv-remote-keyinput.dex';
const LONG_PRESS_MS = 600;
const KEY_RELEASE_MS = 200;
const START_TIMEOUT_MS = 8000;
const JPEG_START = 0xff;
const REPLY_TIMEOUT_MS = 3000;
const RETRY_MS = 60000;

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });
/** Android 9 knows a key only by its full name, and ignores the short one without a word. */
const fullName = name => `KEYCODE_${name}`;

/**
 * A small helper kept running on the device: milliseconds per key, where `input` takes nearly
 * a second. Unlike monkey it leaves accessibility services running.
 */
class KeyInjector {
  constructor({ adb, dexPath }) {
    this.adb = adb;
    this.dexPath = dexPath;
    this.process = null;
    this.waiting = null;
    this.buffer = '';
    this.retryAt = 0;
    this.turn = Promise.resolve();
    this.opening = null;
  }

  get alive() {
    return this.process !== null;
  }

  /** True once the helper runs. Starting costs a push and a long wait, so one that failed is
   *  left alone for a while, and the keys in between take the slow way. */
  ready(name) {
    if (this.alive && !this.opening) return Promise.resolve(true);
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    // Keys and pictures both ask: a second start would kill the first.
    this.opening ??= this.open(name).then(started => {
      if (!started) this.retryAt = Date.now() + RETRY_MS;
      return started;
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  /** Forgets everything about the current device. */
  reset() {
    this.close();
    this.retryAt = 0;
  }

  close() {
    if (this.process) this.process.kill('SIGKILL');
    this.process = null;
    this.buffer = '';
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(new Error('key helper stopped'));
  }

  /** Waits for the helper's next line. */
  nextLine(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeout);
      this.waiting = {
        resolve: line => { clearTimeout(timer); resolve(line); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.resolve(line);
    }
  }

  async open(name) {
    this.close();
    await this.adb.run(['-s', name, 'push', this.dexPath, REMOTE_PATH], { timeout: LONG_TIMEOUT_MS });
    const child = this.adb.spawn(
      ['-s', name, 'shell', `CLASSPATH=${REMOTE_PATH}`, 'app_process', '/', 'KeyInput'],
      ['pipe', 'pipe', 'ignore']);
    this.process = child;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(chunk));
    const ended = () => { if (this.process === child) this.close(); };
    child.once('error', ended);
    child.once('close', ended);
    try {
      if ((await this.nextLine(START_TIMEOUT_MS)) === 'ready') return true;
    } catch {
      return false;
    }
    this.close();
    return false;
  }

  /** One question at a time: there is a single line of answers, for keys and pictures alike. */
  ask(line) {
    const answer = this.turn.then(() => {
      if (!this.process) throw new Error('key helper stopped');
      const reply = this.nextLine(REPLY_TIMEOUT_MS);
      this.process.stdin.write(`${line}\n`);
      return reply;
    });
    this.turn = answer.catch(() => {});
    return answer;
  }

  async say(line) {
    if ((await this.ask(line)) !== 'ok') throw new Error('key helper stopped');
  }

  /** A JPEG of the screen in a fraction of screencap's time, or null where the helper cannot. */
  async shot() {
    if (!this.alive) return null;
    const jpeg = Buffer.from(await this.ask('shot').catch(() => ''), 'base64');
    return jpeg[0] === JPEG_START ? jpeg : null;
  }

  touch(action, x, y) {
    return this.say(`touch ${action} ${x} ${y}`);
  }

  async key(name, longPress) {
    const code = fullName(name);
    if (longPress) {
      await this.say(`down ${code}`);
      await delay(LONG_PRESS_MS);
      await this.say(`long ${code}`);
      await delay(KEY_RELEASE_MS);
      await this.say(`up ${code}`);
    } else {
      await this.say(`press ${code}`);
    }
  }
}

module.exports = { KeyInjector, REMOTE_PATH };
