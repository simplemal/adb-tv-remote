'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { _electron: electron } = require('playwright-core');
const { SERVER_PORT } = require('../../src/main/adb');
const { FAKE_ADB, ROOT, makeWorld, waitFor } = require('../helpers');

const SHOTS = process.env.SHOT_DIR;
const HIDE = ['-r', path.join(ROOT, 'test', 'hide-window.js')];
const NAME = '192.0.2.10:5555';
let fake;
let app;
let page;
let userData;

const launch = () => electron.launch({
  args: [...HIDE, ROOT, `--user-data-dir=${userData}`, '--lang=en-US'],
  env: { ...process.env, ADB_TV_REMOTE_ADB: FAKE_ADB, FAKE_ADB_DIR: fake.dir },
});
const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const helperLines = () => fake.calls().filter(line => line.startsWith('helper: ') && line !== 'helper: shot').map(line => line.slice(8).replace(' KEYCODE_', ' '));

before(async () => {
  fake = makeWorld({ behavior: { [NAME]: 'unauthorized' } });
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-e2e-'));
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('#guide:not([hidden])');
});

after(async () => {
  await app?.close();
  fake?.remove();
  fs.rmSync(userData, { recursive: true, force: true });
});

test('first run opens the guide', async () => {
  assert.equal(await page.textContent('#guide-title'), 'Connect your TV');
  assert.ok(await page.isVisible('[data-step="1"]'));
  await shot('1-guide-step1');
  await page.click('#guide-next');
  assert.ok(await page.isVisible('#guide-address'));
  await shot('2-guide-step2');
});

test('the page has no Node.js and only the small bridge', async () => {
  const seen = await page.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    bridge: Object.keys(window.tvRemote).sort(),
  }));
  assert.equal(seen.require, 'undefined');
  assert.equal(seen.process, 'undefined');
  assert.ok(seen.bridge.includes('sendKey'));
  assert.ok(!seen.bridge.includes('invoke'));
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return { isolated: contents.getLastWebPreferences().contextIsolation, sandbox: contents.getLastWebPreferences().sandbox };
  });
  assert.deepEqual(prefs, { isolated: true, sandbox: true });
});

test('calls with bad values do nothing', async () => {
  const replies = await page.evaluate(async () => [
    await tvRemote.addDevice('--help'),
    await tvRemote.addDevice('a;reboot'),
    await tvRemote.selectDevice('nope'),
  ]);
  assert.deepEqual(replies, [false, false, false]);
});

test('a wrong address is explained in the guide', async () => {
  await page.fill('#guide-address', 'not an address');
  await page.click('#guide-connect button');
  await page.waitForSelector('#guide-invalid:not([hidden])');
});

test('unauthorized device: the guide waits, then finishes when accepted on the TV', async () => {
  await page.fill('#guide-address', '192.0.2.10');
  await page.click('#guide-connect button');
  await page.waitForSelector('[data-step="3"]:not([hidden])');
  await waitFor(async () => (await page.textContent('#guide-outcome')) === 'Accept on the TV', { label: 'accept message' });
  assert.equal(await page.isDisabled('#guide-next'), true);
  await shot('3-guide-accept');
  fake.update(world => { world.devices[NAME] = 'device'; });
  await waitFor(async () => (await page.textContent('#guide-outcome')) === 'Your TV is connected.', { label: 'connected' });
  await page.click('#guide-next');
  assert.equal(await page.isVisible('#guide'), false);
});

test('connected: the light is green and a picture appears', async () => {
  await page.waitForSelector('#light.ok');
  await waitFor(() => page.evaluate(() => document.getElementById('empty').hidden), { label: 'picture' });
  const size = await page.evaluate(() => {
    const image = document.getElementById('screen');
    return [image.naturalWidth, image.naturalHeight];
  });
  assert.deepEqual(size, [960, 540]);
  await shot('4-connected');
});

test('the preview is 16:9 and sits beside the remote', async () => {
  const boxes = await page.evaluate(() => {
    const box = id => document.querySelector(id).getBoundingClientRect().toJSON();
    return { screen: box('.screen'), remote: box('.remote') };
  });
  assert.ok(Math.abs(boxes.screen.width / boxes.screen.height - 16 / 9) < 0.02);
  assert.ok(boxes.remote.left >= boxes.screen.right);
});

test('buttons send keys', async () => {
  await page.click('[data-key="MEDIA_PLAY_PAUSE"]');
  await page.click('.pad .ok');
  await waitFor(() => helperLines().length === 2, { label: 'clicked keys' });
  assert.deepEqual(helperLines(), ['press MEDIA_PLAY_PAUSE', 'press DPAD_CENTER']);
});

test('holding a button sends a long press', async () => {
  const box = await page.locator('[data-key="HOME"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Well past the 2 s hold: a covered window's timers can run up to a second late.
  await new Promise(resolve => { setTimeout(resolve, 3200); });
  await page.mouse.up();
  await waitFor(() => helperLines().includes('up HOME'), { label: `long press, got ${helperLines()}` });
  assert.ok(helperLines().includes('down HOME'));
  assert.ok(!helperLines().includes('press HOME'));
});

test('the keyboard works, and leaves alone what you type in a field', async () => {
  const before = helperLines().length;
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('h');
  await page.keyboard.press('m');
  await waitFor(() => helperLines().length === before + 3, { label: 'keyboard keys' });
  assert.deepEqual(helperLines().slice(-3), ['press DPAD_LEFT', 'press HOME', 'press MENU']);

  await page.click('#open-text');
  await page.keyboard.type("hi it's me");
  await page.keyboard.press('Enter');
  await waitFor(() => fake.calls().some(line => line.includes('input text')), { label: 'text' });
  assert.ok(fake.calls().some(line => line.endsWith(`shell input text 'hi%sit'"'"'s%sme'`)));
  assert.equal(helperLines().length, before + 3);
  assert.equal(await page.getAttribute('#open-text', 'aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#text-card'), false);
  assert.equal(await page.getAttribute('#open-text', 'aria-expanded'), 'false');

  await page.click('#open-text');
  await page.click('#text-card .close');
  assert.equal(await page.isVisible('#text-card'), false);
  assert.equal(await page.getAttribute('#open-text', 'aria-expanded'), 'false');
});

test('a click on the picture touches the device', async () => {
  const box = await page.locator('#screen').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor(() => helperLines().at(-1)?.startsWith('touch up'), { label: 'touch' });
  assert.match(helperLines().at(-2), /^touch (down|move)/);
});

test('power picks SLEEP from the device state', async () => {
  await page.click('[data-key="POWER"]');
  await waitFor(() => helperLines().includes('press SLEEP'), { label: 'sleep' });
});

test('several devices, and each failure has its own message', async () => {
  await page.click('#open-devices');
  assert.equal(await page.textContent('#devices b'), 'Test TV');
  fake.update(world => { world.behavior['192.0.2.20:5555'] = 'refused'; });
  await page.fill('#address', '192.0.2.20');
  await page.click('#connect button');
  await waitFor(async () => (await page.textContent('#empty-title')) === 'The device refused the connection', { label: 'refused' });
  await page.waitForSelector('#light:not(.ok)');
  await page.click('#open-devices');
  await shot('5-devices-refused');

  fake.update(world => { world.behavior['192.0.2.21:5555'] = 'unreachable'; });
  await page.fill('#address', '192.0.2.21');
  await page.click('#connect button');
  await waitFor(async () => (await page.textContent('#empty-title')) === 'Device not reachable', { label: 'unreachable' });

  await page.click('#open-devices');
  assert.equal(await page.locator('#devices li').count(), 3);
  await page.locator('#devices .pick').first().click();
  await page.waitForSelector('#light.ok');
  await page.locator('#devices .forget').last().click();
  await waitFor(async () => (await page.locator('#devices li').count()) === 2, { label: 'removed' });
});

test('switching to Italian changes the whole interface and is remembered', async () => {
  await page.selectOption('#language', 'it');
  await waitFor(async () => (await page.textContent('#status')) === 'Collegato', { label: 'italian' });
  assert.equal(await page.getAttribute('html', 'lang'), 'it');
  assert.equal(await page.getAttribute('[data-key="BACK"]', 'aria-label'), 'Indietro');
  await shot('6-italian');
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('#light.ok');
  assert.equal(await page.textContent('#status'), 'Collegato');
  assert.equal(await page.isVisible('#guide'), false);
});

test('standby shows on the picture and the screensaver does not, even after a slow check', async () => {
  fake.update(world => { world.wakefulness = 'Asleep'; });
  await page.waitForSelector('#power-note:not([hidden])', { timeout: 15000 });
  assert.equal(await page.textContent('#power-title'), 'Il dispositivo è in standby');
  fake.update(world => { world.wakefulness = 'Dreaming'; });
  await page.waitForSelector('#power-note', { state: 'hidden', timeout: 20000 });
  fake.update(world => { world.wakefulness = 'Awake'; });
});

test('adb stays on the private port', () => {
  const ports = new Set(fake.calls().filter(line => line.startsWith('[')).map(line => line.slice(1, line.indexOf(']'))));
  assert.deepEqual([...ports], [String(SERVER_PORT)]);
});

test('the app opens no network port', async () => {
  // Started by hand: Playwright's own launch adds debugger ports that would hide the answer.
  const running = spawn(require('electron'), [ROOT, `--user-data-dir=${userData}-ports`], {
    env: { ...process.env, ADB_TV_REMOTE_ADB: FAKE_ADB, FAKE_ADB_DIR: fake.dir },
    stdio: 'ignore',
  });
  try {
    await waitFor(() => fake.calls().filter(line => line.endsWith('devices')).length > 0, { label: 'app start' });
    await new Promise(resolve => { setTimeout(resolve, 1500); });
    const tree = execFileSync('pgrep', ['-P', String(running.pid)], { encoding: 'utf8' }).trim().split('\n');
    for (const pid of [running.pid, ...tree]) {
      let listening = '';
      try {
        listening = execFileSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' });
      } catch {
        // lsof exits with an error when it finds nothing.
      }
      assert.equal(listening, '');
    }
  } finally {
    running.kill();
    fs.rmSync(`${userData}-ports`, { recursive: true, force: true });
  }
});

test('without adb the app explains what to do', async () => {
  await app.close();
  app = await electron.launch({
    args: [...HIDE, ROOT, `--user-data-dir=${userData}`],
    env: { ...process.env, ADB_TV_REMOTE_ADB: '/nonexistent/adb', FAKE_ADB_DIR: fake.dir },
  });
  page = await app.firstWindow();
  await waitFor(async () => (await page.textContent('#empty-title')) === 'adb non trovato', { label: 'no adb' });
  assert.equal(await page.isVisible('#get-adb'), true);
  await shot('7-no-adb');
});

// Last, because Playwright keeps waiting for the blocked navigation and stops driving the page.
test('a remote page cannot load, even if the page tries', async () => {
  const before = page.url();
  await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
  await new Promise(resolve => { setTimeout(resolve, 200); });
  assert.equal(page.url(), before);
  const opened = await page.evaluate(() => window.open('https://example.com/') === null);
  assert.equal(opened, true);
});
