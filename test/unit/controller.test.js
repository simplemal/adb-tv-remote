'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { Controller } = require('../../src/main/controller');
const { REMOTE_PATH } = require('../../src/main/injector');
const { ScreenCapture } = require('../../src/main/screen');
const { Store } = require('../../src/main/store');
const { BUNDLED_FFMPEG, DEX, FAKE_ADB, makeWorld, waitFor } = require('../helpers');

const NAME = '192.0.2.10:5555';
const OTHER = '192.0.2.11:5555';
let current = [];

function setup({ world = {}, adbPath = FAKE_ADB, ffmpegPath = null, device = '192.0.2.10' } = {}) {
  const fake = makeWorld(world);
  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-store-')), 'config.json'));
  if (device) store.add(device);
  const controller = new Controller({ adbPath, ffmpegPath, dexPath: DEX, store, serverPort: 15999 });
  current.push({ controller, fake });
  return { controller, fake, store };
}

afterEach(async () => {
  for (const { controller, fake } of current) {
    await controller.shutdown();
    fake.remove();
  }
  current = [];
});

const helperLines = fake => fake.calls().filter(line => line.startsWith('helper: ') && line !== 'helper: shot').map(line => line.slice(8).replace(' KEYCODE_', ' '));
const powerReads = fake => fake.calls().filter(line => line.includes('dumpsys power')).length;
const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

test('connected: adb connects and the device name is saved', async () => {
  const { controller, store } = setup();
  await controller.refresh();
  assert.equal(controller.status, 'connected');
  assert.equal(store.selected.name, 'Test TV');
});

test('adb runs on a private server port, never the system one', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  assert.ok(fake.calls().every(line => line.startsWith('[15999] ') || line.startsWith('helper: ')));
});

test('states: unauthorized, refused, unreachable, none, no adb', async () => {
  for (const [behavior, expected] of [['unauthorized', 'unauthorized'], ['refused', 'refused'], ['unreachable', 'unreachable']]) {
    const { controller } = setup({ world: { behavior: { [NAME]: behavior } } });
    await controller.refresh();
    assert.equal(controller.status, expected);
  }
  const empty = setup({ device: null });
  await empty.controller.refresh();
  assert.equal(empty.controller.status, 'no-device');

  const noAdb = setup({ adbPath: null });
  await noAdb.controller.refresh();
  assert.equal(noAdb.controller.status, 'no-adb');
  noAdb.controller.key('HOME');
  noAdb.controller.text('x');
});

test('a missing adb file is a failed check, not a crash, and is not called unreachable', async () => {
  const { controller } = setup({ adbPath: '/nonexistent/adb' });
  await controller.refresh();
  assert.equal(controller.status, 'no-adb');
});

test('a device out of reach keeps adb\'s words, and a new one starts clean', async () => {
  const { controller } = setup({ world: { behavior: { [NAME]: 'unreachable' } } });
  await controller.refresh();
  assert.equal(controller.status, 'unreachable');
  assert.equal(controller.snapshot().reason, 'Operation timed out');
  controller.addDevice('192.0.2.11');
  assert.equal(controller.snapshot().reason, '');
});

test('a connection still waiting for the TV is not called unreachable', async () => {
  const { controller } = setup({ world: { devices: { [NAME]: 'connecting' } } });
  await controller.refresh();
  assert.equal(controller.status, 'unauthorized');
});

test('accepting on the TV turns unauthorized into connected', async () => {
  const { controller, fake } = setup({ world: { behavior: { [NAME]: 'unauthorized' } } });
  await controller.refresh();
  assert.equal(controller.status, 'unauthorized');
  fake.update(world => { world.devices[NAME] = 'device'; });
  await controller.refresh();
  assert.equal(controller.status, 'connected');
});

test('an offline connection is dropped and made again', async () => {
  const { controller, fake } = setup({ world: { devices: { [NAME]: 'offline' } } });
  await controller.refresh();
  assert.equal(controller.status, 'connected');
  const calls = fake.calls().map(line => line.replace('[15999] ', ''));
  const dropped = calls.indexOf(`disconnect ${NAME}`);
  assert.ok(dropped >= 0 && dropped < calls.indexOf(`connect ${NAME}`));
});

test('keys go through the helper, in order, after pushing it once', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  for (const key of ['DPAD_UP', 'DPAD_DOWN', 'HOME']) controller.key(key);
  await waitFor(() => helperLines(fake).length === 3, { label: 'three keys' });
  assert.deepEqual(helperLines(fake), ['press DPAD_UP', 'press DPAD_DOWN', 'press HOME']);
  const calls = fake.calls();
  assert.ok(calls.includes('helper: press KEYCODE_HOME'), 'Android 9 needs the full name');
  assert.equal(calls.filter(line => line.includes(' push ')).length, 1);
  assert.ok(calls.some(line => line.includes(`shell CLASSPATH=${REMOTE_PATH} app_process / KeyInput`)));
  assert.ok(!calls.some(line => line.includes('input keyevent')));
});

test('a long press holds the key down', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  const started = Date.now();
  controller.key('HOME', true);
  await waitFor(() => helperLines(fake).length === 3, { label: 'key up' });
  assert.deepEqual(helperLines(fake), ['down HOME', 'long HOME', 'up HOME']);
  assert.ok(Date.now() - started >= 790);
});

test('touches go through the helper in screen pixels, in order', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.touch('down', 0, 0);
  controller.touch('move', 0.5, 0.5);
  controller.touch('up', 1, 1);
  await waitFor(() => helperLines(fake).length >= 2, { label: 'touches' });
  await waitFor(() => helperLines(fake).at(-1) === 'touch up 1919 1079', { label: 'release' });
  assert.equal(helperLines(fake)[0], 'touch down 0 0');
});

test('touches outside the picture or with unknown actions are refused', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.touch('down', 1.5, 0);
  controller.touch('down', 0, -1);
  controller.touch('down', '0', 0);
  controller.touch('swipe', 0, 0);
  controller.key('HOME');
  await waitFor(() => helperLines(fake).length === 1, { label: 'the key' });
  assert.deepEqual(helperLines(fake), ['press HOME']);
});

test('without the helper a release becomes a tap', async () => {
  const { controller, fake } = setup({ world: { helper: false } });
  await controller.refresh();
  controller.touch('down', 0.5, 0.5);
  controller.touch('up', 0.5, 0.5);
  await waitFor(() => fake.calls().some(line => line.includes('input tap 960 540')), { label: 'tap' });
});

test('a held Menu runs the saved command instead of the key', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.setCommand('menuHold', 'am start -n example/.Tasks');
  controller.key('MENU', true);
  await waitFor(() => fake.calls().some(line => line.endsWith('shell am start -n example/.Tasks')), { label: 'command' });
  controller.setCommand('menuHold', 'bad\ncommand');
  controller.setCommand('other', 'am start');
  assert.equal(controller.snapshot().devices[0].menuHold, 'am start -n example/.Tasks');
  controller.key('MENU');
  await waitFor(() => helperLines(fake).includes('press MENU'), { label: 'short press' });
});

test('Home runs its command when set, and a held Home stays a key', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.setCommand('homeCommand', 'am start -n example/.Home');
  controller.key('HOME');
  await waitFor(() => fake.calls().some(line => line.endsWith('shell am start -n example/.Home')), { label: 'command' });
  controller.key('HOME', true);
  await waitFor(() => helperLines(fake).includes('up HOME'), { label: 'held key' });
});

test('keys outside the list are refused', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.key('REBOOT');
  controller.key('HOME; reboot');
  controller.key('HOME');
  await waitFor(() => helperLines(fake).length === 1, { label: 'home' });
  assert.deepEqual(helperLines(fake), ['press HOME']);
});

test('power sends SLEEP when awake and WAKEUP when asleep', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.key('POWER');
  await waitFor(() => helperLines(fake).length === 1, { label: 'sleep' });
  fake.update(world => { world.wakefulness = 'Asleep'; });
  controller.key('POWER');
  await waitFor(() => helperLines(fake).length === 2, { label: 'wakeup' });
  assert.deepEqual(helperLines(fake), ['press SLEEP', 'press WAKEUP']);
  assert.ok(!fake.calls().some(line => line.includes('POWER')));
});

test('power on the screensaver sends SLEEP, which is what the page announces', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Dreaming' } });
  await controller.refresh();
  controller.key('POWER');
  await waitFor(() => helperLines(fake).length === 1, { label: 'sleep' });
  assert.deepEqual(helperLines(fake), ['press SLEEP']);
});

test('the power state follows the device, and the screensaver counts as awake', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  await controller.reading; // A read still under way would answer for the first state below.
  for (const [wakefulness, expected] of [['Asleep', 'asleep'], ['Dreaming', 'awake'], ['Dozing', 'asleep'], ['Awake', 'awake']]) {
    fake.update(world => { world.wakefulness = wakefulness; });
    await controller.readPower();
    assert.equal(controller.snapshot().power, expected, wakefulness);
  }
});

test('in standby the picture stops and checks slow down, but waking is still noticed', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  const captures = () => fake.calls().filter(line => line.includes('screencap')).length;
  controller.setWatching(true);
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  await waitFor(() => controller.pollTimer !== null, { label: 'next check' });
  await wait(100);
  const seen = captures();
  await wait(900);
  assert.equal(captures(), seen);
  assert.equal(controller.pollDelay(), 15000);
  fake.update(world => { world.wakefulness = 'Awake'; });
  await controller.readPower();
  assert.equal(controller.power, 'awake');
  await waitFor(() => captures() > seen, { label: 'the picture again' });
});

test('a key on a sleeping device checks it soon, in case the key woke it', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  controller.setWatching(true);
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  fake.update(world => { world.wakefulness = 'Awake'; });
  controller.key('HOME');
  await waitFor(() => controller.power === 'awake', { label: 'awake', timeout: 3000 });
});

test('waking: the picture restarts, and "waking" ends once it is back', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  const powers = [];
  const frames = [];
  controller.on('state', state => powers.push(state.power));
  controller.on('frame', (data, kind) => frames.push(kind));
  controller.setWatching(true);
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  frames.length = 0;
  controller.key('POWER');
  await waitFor(() => controller.power === 'waking', { label: 'waking' });
  fake.update(world => { world.wakefulness = 'Awake'; });
  await waitFor(() => controller.power === 'awake', { label: 'awake' });
  assert.ok(helperLines(fake).includes('press WAKEUP'));
  assert.ok(frames.length > 0);
  assert.deepEqual(powers.filter((power, index) => power !== powers[index - 1]).slice(-3), ['asleep', 'waking', 'awake']);
});

test('waking: nothing is captured until the device is awake, or the picture stays black', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  const captures = () => fake.calls().filter(line => line.includes('screencap')).length;
  controller.setWatching(true);
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  await wait(300);
  const seen = captures();
  controller.key('POWER');
  await waitFor(() => controller.power === 'waking', { label: 'waking' });
  await wait(800);
  assert.equal(captures(), seen);
  fake.update(world => { world.wakefulness = 'Awake'; });
  await waitFor(() => captures() > seen, { label: 'the picture again' });
});

test('waking: once the device is awake, waiting for the picture asks it nothing', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  await controller.refresh();
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  controller.key('POWER');
  await waitFor(() => controller.power === 'waking', { label: 'waking' });
  fake.update(world => { world.wakefulness = 'Awake'; });
  await waitFor(() => controller.awakeAt > 0, { label: 'awake' });
  const seen = powerReads(fake);
  await wait(1200);
  assert.equal(powerReads(fake), seen);
  assert.equal(controller.power, 'waking');
  await waitFor(() => controller.power === 'awake', { label: 'gave up waiting', timeout: 5000 });
});

test('a recent frame proves the device is on, so its power is not read', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  await waitFor(() => powerReads(fake) === 1, { label: 'first read' });
  controller.frameAt = Date.now();
  await controller.refresh();
  await wait(100);
  assert.equal(powerReads(fake), 1);
  controller.frameAt = 0;
  await controller.refresh();
  await waitFor(() => powerReads(fake) === 2, { label: 'second read' });
});

test('a key does not wait for a check while the last one is recent', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  const checks = fake.calls().filter(line => line.endsWith(' devices')).length;
  controller.statusAt = Date.now() - 6000;
  assert.equal(await controller.connectedTarget(), NAME);
  assert.equal(fake.calls().filter(line => line.endsWith(' devices')).length, checks);
});

test('a device that does not answer is not asked faster by the waiting preview', async () => {
  const { controller, fake } = setup({ world: { behavior: { [NAME]: 'refused' } } });
  controller.setWatching(true);
  await wait(2800);
  assert.equal(fake.calls().filter(line => line.includes(`connect ${NAME}`)).length, 1);
  assert.deepEqual([1, 2, 3, 4].map(() => controller.pollDelay()).slice(-2), [30000, 30000]);
});

test('while the window cannot be seen nothing is checked, and coming back checks at once', async () => {
  const { controller, fake } = setup();
  controller.pollDelay = () => 20;
  const checks = () => fake.calls().filter(line => line.endsWith(' devices')).length;
  controller.setWatching(true);
  await waitFor(() => checks() >= 3, { label: 'checks' });
  controller.setWatching(false);
  await wait(200);
  const seen = checks();
  await wait(300);
  assert.equal(checks(), seen);
  controller.setWatching(true);
  await waitFor(() => checks() > seen, { label: 'check on return', timeout: 1000 });
});

test('a failed check does not end the checking', async () => {
  const { controller } = setup();
  controller.pollDelay = () => 20;
  let checks = 0;
  controller.check = async () => {
    checks += 1;
    throw new Error('check failed');
  };
  controller.setWatching(true);
  await waitFor(() => checks >= 2, { label: 'second check' });
});

test('changing device forgets the old one\'s power state', async () => {
  const { controller, fake } = setup({ world: { wakefulness: 'Asleep' } });
  await controller.refresh();
  await waitFor(() => controller.power === 'asleep', { label: 'asleep' });
  controller.key('POWER');
  await waitFor(() => controller.power === 'waking', { label: 'waking' });
  fake.update(world => { world.wakefulness = 'Awake'; });
  controller.addDevice('192.0.2.11');
  assert.equal(controller.snapshot().power, 'awake');
  assert.equal(controller.awakeAt, 0);
});

test('if the helper cannot start, keys fall back to input keyevent', async () => {
  const { controller, fake } = setup({ world: { helper: false } });
  await controller.refresh();
  controller.key('HOME');
  controller.key('BACK', true);
  await waitFor(() => fake.calls().filter(line => line.includes('input keyevent')).length === 2, { label: 'fallback' });
  const lines = fake.calls().filter(line => line.includes('input keyevent'));
  assert.ok(lines[0].endsWith('input keyevent HOME'));
  assert.ok(lines[1].endsWith('input keyevent --longpress BACK'));
  assert.equal(fake.calls().filter(line => line.includes(' push ')).length, 1);
});

test('text is quoted for the device shell', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.text("it's here");
  await waitFor(() => fake.calls().some(line => line.includes('input text')), { label: 'text' });
  assert.ok(fake.calls().some(line => line.endsWith(`shell input text 'it'"'"'s%shere'`)));
});

test('keys are dropped while the device is not connected', async () => {
  const { controller, fake } = setup({ world: { behavior: { [NAME]: 'refused' } } });
  await controller.refresh();
  controller.key('HOME');
  await new Promise(resolve => { setTimeout(resolve, 200); });
  assert.deepEqual(helperLines(fake), []);
  assert.ok(!fake.calls().some(line => line.includes('app_process')));
});

test('several saved devices: switching moves keys to the new one', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  controller.key('HOME');
  await waitFor(() => helperLines(fake).length === 1, { label: 'first key' });
  assert.equal(controller.addDevice('192.0.2.11'), true);
  await waitFor(() => controller.status === 'connected', { label: 'second device' });
  controller.key('BACK');
  await waitFor(() => helperLines(fake).length === 2, { label: 'second key' });
  assert.ok(fake.calls().some(line => line.includes(`-s ${OTHER} shell CLASSPATH`)));
  assert.equal(controller.selectDevice('192.0.2.10'), true);
  assert.equal(controller.selectDevice('192.0.2.99'), false);
});

test('switching during a slow check still reaches the new device', async () => {
  const { controller } = setup();
  const first = controller.refresh();
  controller.addDevice('192.0.2.11');
  await first;
  assert.equal(controller.status, 'connected');
  assert.equal(controller.snapshot().selected, '192.0.2.11');
});

test('adding a bad address is refused, and removing the last device leaves none', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  assert.equal(controller.addDevice('--help'), false);
  assert.equal(controller.addDevice(42), false);
  controller.removeDevice('192.0.2.10');
  await waitFor(() => controller.status === 'no-device', { label: 'no device' });
  await waitFor(() => fake.calls().some(line => line.includes(`disconnect ${NAME}`)), { label: 'disconnect' });
  assert.equal(controller.snapshot().selected, '');
});

test('language accepts only known values', () => {
  const { controller, store } = setup();
  controller.setLanguage('it');
  controller.setLanguage('../../etc');
  assert.equal(store.language, 'it');
});

test('a server left behind is replaced on start, and ours stops on shutdown', async () => {
  const { controller, fake } = setup();
  const kills = () => fake.calls().filter(line => line.endsWith('kill-server')).length;
  await controller.refresh();
  const calls = fake.calls();
  assert.ok(calls.findIndex(line => line.endsWith('kill-server')) < calls.findIndex(line => line.endsWith('start-server')));
  assert.equal(kills(), 1);
  await controller.shutdown();
  assert.equal(kills(), 2);
});

test('nothing can start adb again after shutdown', async () => {
  const { controller, fake } = setup();
  await controller.refresh();
  await controller.shutdown();
  const seen = fake.calls().length;
  await controller.refresh();
  await controller.adb.run(['devices']);
  controller.key('HOME');
  await wait(100);
  assert.equal(fake.calls().length, seen);
});

test('preview without ffmpeg: screenshots only, and only while watching', async () => {
  const { controller, fake } = setup();
  const frames = [];
  controller.on('frame', (data, kind) => frames.push({ data, kind }));
  await controller.refresh();
  await new Promise(resolve => { setTimeout(resolve, 150); });
  assert.equal(frames.length, 0);
  controller.setWatching(true);
  await waitFor(() => frames.length >= 2, { label: 'screenshots' });
  assert.ok(frames.every(frame => frame.kind === 'image/png' && frame.data[0] === 0x89));
  assert.ok(!fake.calls().some(line => line.includes('screenrecord')));
  controller.setWatching(false);
  await new Promise(resolve => { setTimeout(resolve, 100); });
  const seen = frames.length;
  await new Promise(resolve => { setTimeout(resolve, 800); });
  assert.equal(frames.length, seen);
});

test('preview with ffmpeg: real H.264 becomes real JPEGs, after a first screenshot', { skip: !fs.existsSync(BUNDLED_FFMPEG) }, async () => {
  const { controller, fake } = setup({ ffmpegPath: BUNDLED_FFMPEG });
  const frames = [];
  controller.on('frame', (data, kind) => frames.push({ data, kind }));
  await controller.refresh();
  controller.setWatching(true);
  await waitFor(() => frames.filter(frame => frame.kind === 'image/jpeg').length >= 20, { label: 'jpeg frames' });
  assert.equal(frames[0].kind, 'image/png');
  const jpeg = frames.find(frame => frame.kind === 'image/jpeg').data;
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  const record = fake.calls().find(line => line.includes('screenrecord'));
  assert.ok(record.endsWith(`-s ${NAME} exec-out screenrecord --output-format=h264 --size 960x540 --bit-rate 4000000 -`));
});

test('the 3-minute recording limit: when the encoder stops, capture starts again', { skip: !fs.existsSync(BUNDLED_FFMPEG) }, async () => {
  const { controller, fake } = setup({ ffmpegPath: BUNDLED_FFMPEG, world: { recording: 'end' } });
  controller.on('frame', () => {});
  await controller.refresh();
  controller.setWatching(true);
  await waitFor(() => fake.calls().filter(line => line.includes('screenrecord')).length >= 2, { label: 'second recording', timeout: 10000 });
});

test('a recording that keeps failing is tried less and less often', { skip: !fs.existsSync(BUNDLED_FFMPEG) }, async () => {
  const { controller, fake } = setup({ ffmpegPath: BUNDLED_FFMPEG, world: { recording: 'end' } });
  controller.on('frame', () => {});
  await controller.refresh();
  controller.setWatching(true);
  await wait(6500);
  assert.ok(fake.calls().filter(line => line.includes('screenrecord')).length <= 3);
});

test('restarting after a full recording takes no screenshot', async () => {
  let screenshots = 0;
  let runs = 0;
  const adb = { run: async () => { screenshots += 1; return { stdout: Buffer.from('\x89PNG', 'latin1') }; } };
  const capture = new ScreenCapture({ adb, ffmpegPath: 'ffmpeg', knownTarget: () => 'tv', publish: () => {} });
  capture.video = async () => { runs += 1; await wait(2050); };
  capture.setWatching(true);
  await waitFor(() => runs === 2, { label: 'second recording' });
  capture.setWatching(false);
  assert.equal(screenshots, 1);
});

test('after a key, once the video goes quiet, a screenshot shows the final picture', { skip: !fs.existsSync(BUNDLED_FFMPEG) }, async () => {
  const { controller } = setup({ ffmpegPath: BUNDLED_FFMPEG });
  const frames = [];
  controller.on('frame', (data, kind) => frames.push(kind));
  await controller.refresh();
  controller.setWatching(true);
  await waitFor(() => frames.includes('image/jpeg'), { label: 'video' });
  await new Promise(resolve => { setTimeout(resolve, 300); });
  frames.length = 0;
  controller.key('DPAD_DOWN');
  await waitFor(() => frames.includes('image/png'), { label: 'settle screenshot', timeout: 5000 });
});

/** A capture with a screenshot we finish by hand, for what happens while it is being taken. */
function slowCapture() {
  const published = [];
  let finish;
  const adb = { run: () => new Promise(resolve => { finish = () => resolve({ stdout: Buffer.from('\x89PNG', 'latin1') }); }) };
  const capture = new ScreenCapture({ adb, connectedTarget: async () => 'tv', publish: (data, kind) => published.push(kind) });
  capture.watching = true;
  return { capture, published, finish: () => finish?.(), asked: () => finish !== undefined };
}

test('a screenshot is shown when nothing happened while it was taken, and old frames are skipped', async () => {
  const { capture, published, finish, asked } = slowCapture();
  capture.noteKey();
  await waitFor(asked, { label: 'screenshot' });
  finish();
  await waitFor(() => published.includes('image/png'), { label: 'published' });
  const signal = new AbortController().signal;
  for (let frame = 0; frame < 4; frame += 1) capture.videoFrame(Buffer.from([frame]), signal);
  assert.deepEqual(published, ['image/png', 'image/jpeg']);
});

test('a moving picture takes no screenshot, and one follows when it stops', async () => {
  const { capture, published, finish, asked } = slowCapture();
  capture.lastVideo = Date.now();
  const moving = setInterval(() => { capture.lastVideo = Date.now(); }, 50);
  capture.noteKey();
  await wait(1000);
  assert.equal(asked(), false);
  clearInterval(moving);
  await waitFor(asked, { label: 'screenshot' });
  finish();
  await waitFor(() => published.includes('image/png'), { label: 'published' });
});

test('a screenshot overtaken by a key is thrown away', async () => {
  const { capture, published, finish, asked } = slowCapture();
  capture.noteKey();
  await waitFor(asked, { label: 'screenshot' });
  capture.lastKey = Date.now() + 1;
  finish();
  await new Promise(resolve => { setTimeout(resolve, 50); });
  assert.deepEqual(published, []);
  capture.watching = false;
});

test('a screenshot overtaken by a video frame is thrown away', async () => {
  const { capture, published, finish, asked } = slowCapture();
  capture.noteKey();
  await waitFor(asked, { label: 'screenshot' });
  capture.videoFrame(Buffer.from([1]), new AbortController().signal);
  capture.lastVideo = Date.now() + 1;
  finish();
  await new Promise(resolve => { setTimeout(resolve, 50); });
  assert.deepEqual(published, ['image/jpeg']);
  capture.watching = false;
});
