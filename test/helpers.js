'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_ADB = path.join(__dirname, 'fake-adb.js');
const ROOT = path.join(__dirname, '..');
const DEX = path.join(ROOT, 'resources', 'keyinput', 'keyinput.dex');
const BUNDLED_FFMPEG = path.join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`, 'ffmpeg');

/** A throwaway folder with a fake world. Sets FAKE_ADB_DIR for this process and its children. */
function makeWorld(world = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-test-'));
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify({ behavior: {}, devices: {}, ...world }));
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  process.env.FAKE_ADB_DIR = dir;
  return {
    dir,
    calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean),
    update(change) {
      const next = { ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      change(next);
      fs.writeFileSync(file, JSON.stringify(next));
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function waitFor(check, { timeout = 8000, every = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => { setTimeout(resolve, every); });
  }
}

module.exports = { FAKE_ADB, ROOT, DEX, BUNDLED_FFMPEG, makeWorld, waitFor };
