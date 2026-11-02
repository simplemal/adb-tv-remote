// Downloads FFmpeg for the systems that cannot be compiled for from a Mac, verifies it, and keeps
// the program and its licence. These are LGPL builds: no x264 and nothing else under the GPL.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The version lives in build-ffmpeg.sh, so every platform ships the same one.
const [, VERSION] = readFileSync(join(root, 'scripts', 'build-ffmpeg.sh'), 'utf8').match(/^VERSION="(.+)"$/m);
const BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-30-13-01';
const PACKAGES = {
  'win32-x64': { file: `ffmpeg-n${VERSION}-27-g8dca1586f4-win64-lgpl-8.1.zip`, sha256: 'bf346925ea085c262d15a5ceacd521ccbde52f4e3fc6a97f1bf273685fc1a539', binary: 'ffmpeg.exe' },
  'linux-x64': { file: `ffmpeg-n${VERSION}-27-g8dca1586f4-linux64-lgpl-8.1.tar.xz`, sha256: '223c160e95ecf4e204c81f6e69649b6380b2609514f31773a38d9be4a70231b1', binary: 'ffmpeg' },
};

for (const [target, pack] of Object.entries(PACKAGES)) {
  const out = join(root, 'resources', 'bin', target);
  if (existsSync(join(out, pack.binary))) {
    console.log(`FFmpeg already present in ${out}`);
    continue;
  }
  const response = await fetch(`${BASE}/${pack.file}`);
  if (!response.ok) throw new Error(`${pack.file}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== pack.sha256) throw new Error(`Checksum mismatch for ${pack.file}: ${digest}`);

  const work = mkdtempSync(join(tmpdir(), 'ffmpeg-'));
  try {
    const file = join(work, pack.file);
    writeFileSync(file, archive);
    execFileSync('tar', ['-xf', file, '-C', work]);
    const folder = join(work, readdirSync(work).find(name => name.startsWith('ffmpeg-') && name !== pack.file));
    mkdirSync(out, { recursive: true });
    cpSync(join(folder, 'bin', pack.binary), join(out, pack.binary));
    cpSync(join(folder, 'LICENSE.txt'), join(out, 'FFmpeg-LICENSE.txt'));
    writeFileSync(join(out, 'FFmpeg-BUILD-INFO.txt'), `FFmpeg ${VERSION}, LGPL build from ${BASE}/${pack.file}\nSource: https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz and https://github.com/BtbN/FFmpeg-Builds\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`FFmpeg saved in ${out}`);
}
