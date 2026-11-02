// Downloads Google's platform-tools, verifies them, and keeps only adb and its notices.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '37.0.1';
const PACKAGES = {
  darwin: { file: 'darwin', sha256: 'ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d', keep: ['adb'] },
  linux: { file: 'linux', sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1', keep: ['adb'] },
  win32: {
    file: 'win',
    sha256: '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99',
    keep: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'],
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.env.TARGET_PLATFORM || process.platform;
const arch = process.env.TARGET_ARCH || process.arch;
const pack = PACKAGES[platform];
if (!pack) throw new Error(`No platform-tools for ${platform}`);
const out = join(root, 'resources', 'bin', `${platform}-${arch}`);

if (existsSync(join(out, pack.keep[0]))) {
  console.log(`adb already present in ${out}`);
} else {
  const url = `https://dl.google.com/android/repository/platform-tools_r${VERSION}-${pack.file}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(zip).digest('hex');
  if (digest !== pack.sha256) throw new Error(`Checksum mismatch for ${url}: ${digest}`);

  const work = mkdtempSync(join(tmpdir(), 'platform-tools-'));
  try {
    const archive = join(work, 'platform-tools.zip');
    writeFileSync(archive, zip);
    // tar reads zip files on Windows 10+ and macOS; unzip is the usual tool on Linux.
    if (process.platform === 'linux') execFileSync('unzip', ['-q', archive, '-d', work]);
    else execFileSync('tar', ['-xf', archive, '-C', work]);
    mkdirSync(out, { recursive: true });
    for (const name of pack.keep) cpSync(join(work, 'platform-tools', name), join(out, name));
    writeFileSync(join(out, 'adb-NOTICE.txt'), readFileSync(join(work, 'platform-tools', 'NOTICE.txt')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`adb ${VERSION} saved in ${out}`);
}
