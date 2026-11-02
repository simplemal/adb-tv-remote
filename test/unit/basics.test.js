'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { isValidAddress, target } = require('../../src/main/adb');
const { findTool } = require('../../src/main/binaries');
const { KEYS, shellQuote, textCommand, TEXT_LIMIT } = require('../../src/main/keys');
const { JpegSplitter } = require('../../src/main/screen');
const { Store } = require('../../src/main/store');
const { localNetworks, probe, scan } = require('../../src/main/scan');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adb-tv-remote-unit-'));

test('addresses: accepts hosts and ports, refuses anything an adb option could hide in', () => {
  for (const good of ['192.168.1.20', '192.168.1.20:5555', 'tv.local', 'living-room', 'a:1', 'a:65535']) {
    assert.equal(isValidAddress(good), true, good);
  }
  for (const bad of ['', ' ', '-s', '--help', '1.2.3.4:', '1.2.3.4:0', '1.2.3.4:70000', 'a b', 'a;rm', '$(x)', 'a:1:2', null, 5, 'x'.repeat(300)]) {
    assert.equal(isValidAddress(bad), false, String(bad));
  }
});

test('target adds the default port only when none is given', () => {
  assert.equal(target('192.168.1.20'), '192.168.1.20:5555');
  assert.equal(target('192.168.1.20:5000'), '192.168.1.20:5000');
});

test('keys: the set the interface may send', () => {
  assert.equal(KEYS.size, 17);
  assert.ok(KEYS.has('POWER'));
  assert.ok(!KEYS.has('SLEEP'));
});

test('text: spaces, quotes, limits and control characters', () => {
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(textCommand('hello big world'), "input text 'hello%sbig%sworld'");
  assert.equal(textCommand("a';reboot;'"), `input text 'a'"'"';reboot;'"'"''`);
  assert.equal(textCommand('a\nreboot'), "input text 'areboot'");
  assert.equal(textCommand(''), null);
  assert.equal(textCommand('\n'), null);
  assert.equal(textCommand(5), null);
  assert.equal(textCommand('x'.repeat(500)).length, `input text ''`.length + TEXT_LIMIT);
});

test('JPEG splitter: handles frames cut anywhere and noise between them', () => {
  const frame = fill => Buffer.from([0xff, 0xd8, fill, fill, 0xff, 0xd9]);
  const noise = Buffer.from([1, 2, 3]);
  const stream = Buffer.concat([noise, frame(7), noise, frame(8), frame(9)]);
  for (let cut = 1; cut < stream.length; cut++) {
    const splitter = new JpegSplitter();
    const frames = [...splitter.push(stream.subarray(0, cut)), ...splitter.push(stream.subarray(cut))];
    assert.deepEqual(frames.map(item => item[2]), [7, 8, 9], `cut at ${cut}`);
  }
});

test('store: remembers devices, selection and language', () => {
  const file = path.join(tempDir(), 'nested', 'config.json');
  const store = new Store(file);
  assert.equal(store.selected, null);
  store.add('10.0.0.1');
  store.add('10.0.0.2');
  store.add('10.0.0.1');
  store.rename('10.0.0.1', 'Bedroom');
  store.language = 'it';
  const again = new Store(file);
  assert.deepEqual(again.devices.map(device => device.address), ['10.0.0.1', '10.0.0.2']);
  assert.equal(again.selected.name, 'Bedroom');
  assert.equal(again.language, 'it');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  again.remove('10.0.0.1');
  assert.equal(again.selected.address, '10.0.0.2');
  again.remove('10.0.0.2');
  assert.equal(again.selected, null);
});

test('store: a damaged file starts clean', () => {
  const file = path.join(tempDir(), 'config.json');
  for (const damaged of ['{nope', '[]', '{"devices":"x"}', '{"devices":[1,{"address":5}]}']) {
    fs.writeFileSync(file, damaged);
    assert.deepEqual(new Store(file).devices, []);
  }
});

test('store: a hand-edited file cannot reach adb or the device shell', () => {
  const file = path.join(tempDir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    devices: [
      { address: '--help' },
      { address: '10.0.0.1', menuHold: 'bad\ncommand', homeCommand: 'x'.repeat(301) },
      { address: '10.0.0.2', menuHold: 'am start -n example/.Tasks' },
    ],
  }));
  const { devices } = new Store(file);
  assert.deepEqual(devices.map(device => device.address), ['10.0.0.1', '10.0.0.2']);
  assert.deepEqual([devices[0].menuHold, devices[0].homeCommand], ['', '']);
  assert.equal(devices[1].menuHold, 'am start -n example/.Tasks');
});

test('tools: override, then bundled, then system', () => {
  const dir = tempDir();
  const make = (folder, name) => {
    const file = path.join(dir, folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o755);
    return file;
  };
  const bundled = make('bundled', 'adb');
  const system = make('system', 'adb');
  const sdk = make('sdk/platform-tools', 'adb');
  const home = tempDir();
  const base = { platform: 'linux', home };
  const bundledDir = path.dirname(bundled);
  const emptyPath = { PATH: '' };
  assert.equal(findTool('adb', { ...base, bundledDir, env: { PATH: path.dirname(system) } }), bundled);
  assert.equal(findTool('adb', { ...base, env: { PATH: path.dirname(system) } }), system);
  assert.equal(findTool('adb', { ...base, env: { ...emptyPath, ANDROID_HOME: path.join(dir, 'sdk') } }), sdk);
  assert.equal(findTool('adb', { ...base, bundledDir, env: { ADB_TV_REMOTE_ADB: system } }), system);
  assert.equal(findTool('adb', { ...base, bundledDir, env: { ADB_TV_REMOTE_ADB: '/nonexistent' } }), null);
});

test('scan: only private networks of this computer, and sorted results', async () => {
  const networks = localNetworks({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.7' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    en1: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }],
    en2: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }],
    en3: [{ family: 'IPv4', internal: false, address: '172.20.0.9' }],
  });
  assert.deepEqual(networks, ['192.168.1', '172.20.0']);

  const wide = (address, netmask) => localNetworks({ en0: [{ family: 'IPv4', internal: false, address, netmask }] });
  assert.deepEqual(wide('192.168.0.40', '255.255.254.0'), ['192.168.0', '192.168.1']);
  assert.deepEqual(wide('192.168.1.38', '255.255.254.0'), ['192.168.1', '192.168.0']);
  assert.deepEqual(wide('10.0.6.9', '255.255.252.0'), ['10.0.6', '10.0.4', '10.0.5', '10.0.7']);
  assert.deepEqual(wide('10.1.2.3', '255.0.0.0'), ['10.1.2']);
  assert.deepEqual(wide('192.168.0.9', '255.255.255.128'), ['192.168.0']);
  assert.deepEqual(wide('192.168.3.2', '255.255.255.255'), []);

  const asked = [];
  const answers = { 3: 'open', 20: 'open', 1: 'alive' };
  const result = await scan({
    networks: ['192.168.1'],
    test: async host => { asked.push(host); return answers[host.split('.').pop()] ?? 'none'; },
  });
  assert.equal(asked.length, 254);
  assert.deepEqual(result, { found: ['192.168.1.3', '192.168.1.20'], seen: 3, networks: ['192.168.1'] });
});

test('scan: a device that answers and refuses counts, one that says nothing does not', async () => {
  const silent = await scan({ networks: ['192.168.1'], test: async () => 'none' });
  assert.deepEqual(silent, { found: [], seen: 0, networks: ['192.168.1'] });
  const server = net.createServer();
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  assert.equal(await probe('127.0.0.1', port), 'open');
  await new Promise(resolve => { server.close(resolve); });
  assert.equal(await probe('127.0.0.1', port), 'alive');
});
