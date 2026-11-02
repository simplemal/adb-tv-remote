'use strict';
/*
 * The real adb binary against a pretend device on this computer's loopback address, to check
 * that the states the app reads match what adb really prints. Nothing leaves this computer:
 * adb gets a throwaway HOME, so it holds no keys and knows no device.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { Adb } = require('../../src/main/adb');
const { ROOT, waitFor } = require('../helpers');

const REAL_ADB = path.join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`, 'adb');
const SERVER_PORT = 15938;
const CNXN = 0x4e584e43;
const AUTH = 0x48545541;
const skip = !fs.existsSync(REAL_ADB);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-home-'));
const realHome = process.env.HOME;
let adb;
const devices = [];

function packet(command, arg0, arg1, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0, 4);
  header.writeUInt32LE(arg1, 8);
  header.writeUInt32LE(data.length, 12);
  header.writeUInt32LE(data.reduce((sum, byte) => sum + byte, 0), 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, data]);
}

/** Speaks just enough of adbd's handshake: asks for a key, or accepts at once. */
function pretendDevice(accepts) {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 24) {
          const size = 24 + buffer.readUInt32LE(12);
          if (buffer.length < size) return;
          const command = buffer.readUInt32LE(0);
          buffer = buffer.subarray(size);
          if (accepts) socket.write(packet(CNXN, 0x01000001, 1048576, Buffer.from('device::ro.product.name=test;')));
          else if (command === CNXN) socket.write(packet(AUTH, 1, 0, Buffer.alloc(20, 7)));
          else if (command === AUTH) socket.write(packet(AUTH, 1, 0, Buffer.alloc(20, 8)));
        }
      });
    });
    devices.push(server);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

before(async () => {
  if (skip) return;
  process.env.HOME = home;
  adb = new Adb({ path: REAL_ADB, serverPort: SERVER_PORT });
  await adb.startServer();
});

after(async () => {
  process.env.HOME = realHome;
  await adb?.killServer();
  for (const server of devices) server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('the private adb server listens on loopback only, on its own port', { skip }, () => {
  const listening = execFileSync('lsof', ['-nP', `-iTCP:${SERVER_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  assert.match(listening, new RegExp(`127\\.0\\.0\\.1:${SERVER_PORT}`));
  assert.doesNotMatch(listening, /\*:/);
});

test('refused: nothing on that port', { skip }, async () => {
  const closed = await new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  assert.equal(await adb.connect(`127.0.0.1:${closed}`), 'refused');
});

test('unauthorized: the device asks for a key', { skip }, async () => {
  const port = await pretendDevice(false);
  assert.equal(await adb.connect(`127.0.0.1:${port}`), 'unauthorized');
  // It stays listed, so later checks do not connect again and ask the TV twice.
  await waitFor(async () => (await adb.listed(`127.0.0.1:${port}`)) === 'unauthorized', { label: 'listed' });
  await new Promise(resolve => { setTimeout(resolve, 1000); });
  assert.equal(await adb.listed(`127.0.0.1:${port}`), 'unauthorized');
  assert.equal(await adb.connect(`127.0.0.1:${port}`), 'unauthorized');
});

test('connected: the device accepts', { skip }, async () => {
  const port = await pretendDevice(true);
  await waitFor(async () => (await adb.connect(`127.0.0.1:${port}`)) === 'connected', { timeout: 6000, label: 'connected' });
});
