'use strict';

const RETRY_MS = 3000;
/** Fire TV remotes do not go through /dev/input: this log line is the only trace of a key. */
const LOG_ARGS = ['shell', 'logcat', '-v', 'raw', '-T', '1', '-e', 'Received.Key.name'];
const LOG_LINE = /Received Key name: (\w+), code: \d+, action: ([01])/;
const DOWN = '0';

/**
 * Tells which keys were pressed on the device, by any remote, so the window can light them up.
 * Runs only while the window can be seen. Devices without that log line simply say nothing.
 */
class KeyEcho {
  constructor({ adb, knownTarget, publish }) {
    this.adb = adb;
    this.knownTarget = knownTarget;
    this.publish = publish;
    this.watching = false;
    this.process = null;
    this.timer = null;
    this.buffer = '';
    this.started = 0;
  }

  setWatching(watching) {
    if (watching === this.watching) return;
    this.watching = watching;
    if (watching) this.start();
    else this.stop();
  }

  stop() {
    clearTimeout(this.timer);
    this.process?.kill('SIGKILL');
    this.process = null;
    this.buffer = '';
  }

  /** Drops the current device's log and starts on the new one. */
  restart() {
    this.stop();
    if (this.watching) this.start();
  }

  start() {
    const name = this.knownTarget();
    if (!name) return;
    const child = this.adb.spawn(['-s', name, ...LOG_ARGS], ['ignore', 'pipe', 'ignore']);
    this.process = child;
    this.started = Date.now();
    child.stdout.setEncoding('utf8');
    child.stdout.on('error', () => {});
    child.stdout.on('data', chunk => this.receive(chunk));
    const ended = () => {
      if (this.process !== child) return;
      this.process = null;
      if (this.watching) this.timer = setTimeout(() => this.start(), RETRY_MS);
    };
    child.once('error', ended);
    child.once('close', ended);
  }

  receive(chunk) {
    const lines = (this.buffer + chunk).split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      const match = LOG_LINE.exec(line);
      // logcat first repeats the last line it has: that key is long gone.
      if (match && Date.now() - this.started > RETRY_MS) this.publish(match[1], match[2] === DOWN);
    }
  }
}

module.exports = { KeyEcho };
