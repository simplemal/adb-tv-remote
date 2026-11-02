'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT } = require('../helpers');
const { DECODE_ARGS, RECORD_ARGS } = require('../../src/main/screen');
const { STRINGS } = require('../../src/renderer/i18n');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : [file];
  });
}

test('rule: the app never starts monkey or uiautomator, they suspend accessibility services', () => {
  for (const file of sources(path.join(ROOT, 'src'))) {
    const code = fs.readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
    assert.doesNotMatch(code, /monkey\b|uiautomator/i, file);
  }
});

test('rule: the video settings stay as tested', () => {
  assert.ok(!DECODE_ARGS.includes('nobuffer'));
  assert.ok(!DECODE_ARGS.includes('-fflags'));
  assert.deepEqual(DECODE_ARGS.slice(0, 15), ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay',
    '-threads', '1', '-probesize', '2048', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0']);
  assert.ok(DECODE_ARGS.includes('yuvj420p'));
  assert.deepEqual(RECORD_ARGS, ['exec-out', 'screenrecord', '--output-format=h264',
    '--size', '960x540', '--bit-rate', '4000000', '-']);
});

test('rule: nothing listens: no HTTP server anywhere in the app', () => {
  for (const file of sources(path.join(ROOT, 'src'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /createServer|\.listen\(/, file);
  }
});

test('rule: the window keeps its protections', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  for (const needed of ['contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'webviewTag: false']) {
    assert.ok(main.includes(needed), needed);
  }
  const page = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.match(page, /Content-Security-Policy/);
  assert.doesNotMatch(page, /https?:\/\//);
  assert.doesNotMatch(page, /<script>/);
});

test('translations: both languages have the same keys, and the page uses only known keys', () => {
  assert.deepEqual(Object.keys(STRINGS.it).sort(), Object.keys(STRINGS.en).sort());
  for (const [key, value] of Object.entries(STRINGS.it)) {
    if (key !== 'empty.connecting.text') assert.notEqual(value, '', key);
  }
  const page = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const used = [...page.matchAll(/data-i18n(?:-\w+)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(used.length > 40);
  for (const key of used) assert.ok(key in STRINGS.en, key);
  for (const status of ['connecting', 'connected', 'unauthorized', 'refused', 'unreachable', 'no-device', 'no-adb']) {
    assert.ok(`status.${status}` in STRINGS.en, status);
    assert.ok(`empty.${status}.title` in STRINGS.en, status);
  }
});
