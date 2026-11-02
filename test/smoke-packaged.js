'use strict';
/*
 * Starts the packaged app with the fake adb and checks the path from the bundle to a live
 * preview: the page loads from the app archive, the bundled ffmpeg runs, and quitting cleans up.
 * Usage: node test/smoke-packaged.js [path to the app's executable]
 */
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SERVER_PORT } = require('../src/main/adb');
const { FAKE_ADB, ROOT, makeWorld, waitFor } = require('./helpers');

const executable = process.argv[2]
  ?? path.join(ROOT, 'dist', 'mac-arm64', 'ADB TV Remote.app', 'Contents', 'MacOS', 'ADB TV Remote');

function processesNamed(text) {
  try {
    return execFileSync('pgrep', ['-f', text], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const fake = makeWorld();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-smoke-'));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    devices: [{ address: '192.0.2.10', name: 'Test TV' }], selected: '192.0.2.10', language: 'en',
  }));
  const app = spawn(executable, [`--user-data-dir=${userData}`], {
    env: { ...process.env, ADB_TV_REMOTE_ADB: FAKE_ADB, FAKE_ADB_DIR: fake.dir },
    stdio: 'ignore',
  });
  try {
    await waitFor(() => fake.calls().some(line => line.includes('connect 192.0.2.10:5555')), { timeout: 15000, label: 'connect' });
    await waitFor(() => fake.calls().some(line => line.includes('screencap')), { label: 'screenshot' });
    await waitFor(() => fake.calls().some(line => line.includes('screenrecord')), { label: 'recording' });
    const bundled = path.join(path.dirname(executable), '..', 'Resources', 'bin', 'ffmpeg');
    await waitFor(() => processesNamed(path.normalize(bundled)).length > 0, { label: 'bundled ffmpeg' });
    assert.ok(fake.calls().every(line => !line.startsWith('[') || line.startsWith(`[${SERVER_PORT}]`)));
    const kills = () => fake.calls().filter(line => line.endsWith('kill-server')).length;
    const killsAtStart = kills();

    if (process.env.SMOKE_HOLD_MS) await new Promise(resolve => { setTimeout(resolve, Number(process.env.SMOKE_HOLD_MS)); });

    app.kill('SIGTERM');
    await waitFor(() => app.exitCode !== null || app.signalCode !== null, { label: 'exit' });
    await waitFor(() => processesNamed(path.normalize(bundled)).length === 0, { label: 'ffmpeg stopped' });
    assert.ok(kills() > killsAtStart, 'adb server stopped on quit');
    console.log('Packaged app: page, adb calls, bundled ffmpeg and clean exit all work.');
  } finally {
    app.kill('SIGKILL');
    fake.remove();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
