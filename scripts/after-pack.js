'use strict';
/*
 * Gives the app's programs a Mach-O UUID of their own, before they are signed. Every Electron app of
 * a version shares the same one, and macOS uses it to tell who asks for the local network: it took
 * this app for "Electron", already allowed, so it never showed the question and blocked the app.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MH_MAGIC_64 = 0xfeedfacf;
const HEADER_SIZE = 32;
const LC_UUID = 0x1b;

function setUuid(file, seed) {
  const data = fs.readFileSync(file);
  if (data.readUInt32LE(0) !== MH_MAGIC_64) throw new Error(`Not a 64-bit Mach-O: ${file}`);
  let at = HEADER_SIZE;
  for (let left = data.readUInt32LE(16); left > 0; left -= 1) {
    if (data.readUInt32LE(at) === LC_UUID) {
      const uuid = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
      // Version 4, variant 1: the shape of a UUID, whatever the hash gave.
      uuid[6] = (uuid[6] & 0x0f) | 0x40;
      uuid[8] = (uuid[8] & 0x3f) | 0x80;
      uuid.copy(data, at + 8);
      fs.writeFileSync(file, data);
      return;
    }
    at += data.readUInt32LE(at + 4);
  }
  throw new Error(`No UUID in ${file}`);
}

module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  const { id, productFilename } = packager.appInfo;
  const contents = path.join(appOutDir, `${productFilename}.app`, 'Contents');
  const frameworks = path.join(contents, 'Frameworks');
  const helpers = fs.readdirSync(frameworks).filter(name => name.endsWith('.app'));
  const programs = [
    path.join(contents, 'MacOS', productFilename),
    ...helpers.map(name => path.join(frameworks, name, 'Contents', 'MacOS', path.basename(name, '.app'))),
  ];
  for (const program of programs) setUuid(program, `${id}:${path.basename(program)}:${process.arch}`);
};
