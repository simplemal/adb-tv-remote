#!/usr/bin/env node
'use strict';
/*
 * Stands in for adb in the tests. It never touches the network: everything it "knows" lives in
 * FAKE_ADB_DIR/world.json, and every call it receives is appended to FAKE_ADB_DIR/calls.log.
 *
 * world.json: { "behavior": { "<address:port>": "accept" | "unauthorized" | "refused" | "unreachable" },
 *               "devices": { "<address:port>": "device" | "unauthorized" | "offline" },
 *               "wakefulness": "Awake" | "Asleep" | "Dozing" | "Dreaming", "helper": true,
 *               "recording": "stay" | "end" }
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.FAKE_ADB_DIR;
const fixtures = path.join(__dirname, 'fixtures');
const worldFile = path.join(dir, 'world.json');
const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
const save = () => fs.writeFileSync(worldFile, JSON.stringify(world));
const log = line => fs.appendFileSync(path.join(dir, 'calls.log'), `${line}\n`);

let args = process.argv.slice(2);
log(`[${process.env.ANDROID_ADB_SERVER_PORT}] ${args.join(' ')}`);
if (args[0] === '-s') args = args.slice(2);
const [command, ...rest] = args;

function connect(name) {
  const behavior = world.behavior?.[name] ?? 'accept';
  if (behavior === 'accept') {
    world.devices[name] = 'device';
    console.log(`connected to ${name}`);
  } else if (behavior === 'unauthorized') {
    world.devices[name] = 'unauthorized';
    console.log(`failed to authenticate to ${name}`);
  } else if (behavior === 'refused') {
    console.log(`failed to connect to '${name}': Connection refused`);
  } else {
    console.log(`failed to connect to ${name}: Operation timed out`);
  }
  save();
}

function helper() {
  if (world.helper === false) process.exit(1);
  console.log('ready');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      log(`helper: ${buffer.slice(0, end)}`);
      buffer = buffer.slice(end + 1);
      console.log('ok');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function shell(line) {
  if (line.includes('app_process')) return helper();
  if (line.startsWith('dumpsys power')) console.log(`mWakefulness=${world.wakefulness ?? 'Awake'}`);
  if (line === 'settings get global device_name') console.log('Test TV');
  if (line === 'wm size') console.log('Physical size: 1920x1080');
  return undefined;
}

function record() {
  process.stdout.write(fs.readFileSync(path.join(fixtures, 'sample.h264')), () => {
    if (world.recording === 'end') process.exit(0);
    setInterval(() => {}, 1000); // A still screen: the encoder goes quiet but stays open.
  });
}

switch (command) {
  case 'devices':
    console.log('List of devices attached');
    for (const [name, state] of Object.entries(world.devices)) console.log(`${name}\t${state}`);
    break;
  case 'connect':
    connect(rest[0]);
    break;
  case 'disconnect':
    delete world.devices[rest[0]];
    save();
    break;
  case 'shell':
    shell(rest.join(' '));
    break;
  case 'exec-out':
    if (rest[0] === 'screencap') process.stdout.write(fs.readFileSync(path.join(fixtures, 'sample.png')));
    if (rest[0] === 'screenrecord') record();
    break;
  default:
    break;
}
