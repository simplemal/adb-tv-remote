'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Places a tool may be installed. An app opened from the Dock gets a very short PATH. */
function searchDirs(tool, { env, platform, home }) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (tool === 'adb') {
    for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
      if (sdk) dirs.push(path.join(sdk, 'platform-tools'));
    }
    if (platform === 'darwin') dirs.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
    if (platform === 'linux') dirs.push(path.join(home, 'Android', 'Sdk', 'platform-tools'));
    if (platform === 'win32' && env.LOCALAPPDATA) {
      dirs.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools'));
    }
  }
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin');
  return dirs;
}

/**
 * Finds `tool` ("adb" or "ffmpeg"): an explicit override, then the copy shipped with the app,
 * then the system. Returns its path, or null.
 */
function findTool(tool, { bundledDir, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const override = env[`ADB_TV_REMOTE_${tool.toUpperCase()}`];
  if (override) return isExecutable(override) ? override : null;

  const file = platform === 'win32' ? `${tool}.exe` : tool;
  const dirs = [...(bundledDir ? [bundledDir] : []), ...searchDirs(tool, { env, platform, home })];
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

module.exports = { findTool };
