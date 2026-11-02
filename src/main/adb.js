'use strict';
const { spawn } = require('node:child_process');

const DEFAULT_PORT = 5555;
/** adb's own server for this app. See README, "Why a private adb server". */
const SERVER_PORT = 15037;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;
const RUN_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 6000;
const LONG_TIMEOUT_MS = 10000;
const KILL_TIMEOUT_MS = 2000;

function isValidAddress(address) {
  if (typeof address !== 'string' || address.length > 255 || !ADDRESS.test(address)) return false;
  const port = address.split(':')[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

/** adb's name for a device: the address, with the default port if none was given. */
function target(address) {
  return address.includes(':') ? address : `${address}:${DEFAULT_PORT}`;
}

class Adb {
  constructor({ path, serverPort = SERVER_PORT }) {
    this.path = path;
    this.closed = false;
    this.reason = '';
    this.running = new Set();
    // Devices are reached by address, so the server need not browse the network (ADB_MDNS),
    // watch USB (ADB_USB) or look for emulators (ADB_EMU).
    this.env = {
      ...process.env,
      ANDROID_ADB_SERVER_PORT: String(serverPort),
      ADB_MDNS: '0',
      ADB_USB: '0',
      ADB_EMU: '0',
    };
    // Each of these could put us on another server, or keep ours from stopping.
    delete this.env.ADB_SERVER_SOCKET;
    delete this.env.ANDROID_ADB_SERVER_ADDRESS;
    delete this.env.ADB_REJECT_KILL_SERVER;
  }

  spawn(args, stdio) {
    if (this.closed) throw new Error('adb is closed');
    return spawn(this.path, args, { env: this.env, stdio, windowsHide: true });
  }

  /** Runs adb to the end. Never rejects: failures come back as empty output. */
  run(args, { timeout = RUN_TIMEOUT_MS, signal, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
    return new Promise(resolve => {
      const stdout = [];
      let stderr = '';
      let child;
      try {
        child = this.spawn(args, stdio);
      } catch {
        resolve({ stdout: Buffer.alloc(0), text: '', stderr: '', failed: true });
        return;
      }
      const kill = () => child.kill('SIGKILL');
      let timedOut = false;
      let failed = false;
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      this.running.add(kill);
      signal?.addEventListener('abort', kill, { once: true });
      child.stdout?.on('data', chunk => stdout.push(chunk));
      child.stderr?.on('data', chunk => { stderr += chunk; });
      const finish = () => {
        clearTimeout(timer);
        this.running.delete(kill);
        signal?.removeEventListener('abort', kill);
        const output = Buffer.concat(stdout);
        resolve({ stdout: output, text: output.toString(), stderr, timedOut, failed });
      };
      child.once('error', () => { failed = true; finish(); });
      child.once('close', finish);
    });
  }

  /** Runs a command in the device's shell. */
  shell(name, command, options) {
    return this.run(['-s', name, 'shell', command], options);
  }

  /**
   * Starts a server of this build. One left by a crash or by an older copy of the app would be
   * kept otherwise, with whatever rights that copy had. Only one copy of the app runs at a time,
   * so such a server has no owner. Its output is detached, so no later call inherits our pipes.
   */
  async startServer() {
    await this.killServer();
    await this.run(['start-server'], { timeout: LONG_TIMEOUT_MS, stdio: 'ignore' });
  }

  killServer() {
    return this.run(['kill-server'], { timeout: KILL_TIMEOUT_MS });
  }

  /** Stops the server for good. Any adb client starts a server if it finds none, so none may follow. */
  close() {
    for (const kill of this.running) kill();
    const stopped = this.killServer();
    this.closed = true;
    return stopped;
  }

  async listed(name) {
    const { text } = await this.run(['devices']);
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && parts[0] === name) return parts[1];
    }
    return null;
  }

  /**
   * One of: connected, unauthorized, refused, unreachable, no-adb. Connects if needed, and replaces
   * a dead ("offline") connection with a new one. `reason` keeps adb's own words for a failure, or
   * "timeout": the TV is out of reach for different causes, and only these words tell them apart.
   */
  async connect(address) {
    const name = target(address);
    let found = await this.listed(name);
    let answer = '';
    this.reason = '';
    if (found === null || found === 'offline') {
      if (found === 'offline') await this.run(['disconnect', name]);
      const { text, stderr, timedOut, failed } = await this.run(['connect', name], { timeout: CONNECT_TIMEOUT_MS });
      if (failed) return 'no-adb';
      answer = text + stderr;
      this.reason = timedOut ? 'timeout' : answer.trim().split(': ').pop();
      found = await this.listed(name);
    }
    if (found === 'device') return 'connected';
    if (['unauthorized', 'authorizing', 'connecting'].includes(found) || /authenticate/i.test(answer)) return 'unauthorized';
    return /refused/i.test(answer) ? 'refused' : 'unreachable';
  }

  /** A friendly device name, or an empty string. */
  async deviceName(address) {
    const name = target(address);
    const ask = async command => (await this.shell(name, command)).text.trim();
    const label = await ask('settings get global device_name');
    return label && label !== 'null' ? label : ask('getprop ro.product.model');
  }
}

module.exports = { Adb, DEFAULT_PORT, LONG_TIMEOUT_MS, SERVER_PORT, isValidAddress, target };
