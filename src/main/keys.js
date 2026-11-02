'use strict';

/** Keys the interface may send. Anything else from the page is refused. */
const KEYS = new Set([
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER', 'BACK', 'HOME', 'MENU',
  'MEDIA_REWIND', 'MEDIA_PLAY_PAUSE', 'MEDIA_FAST_FORWARD',
  'VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_MUTE', 'GUIDE', 'POWER', 'SETTINGS',
]);

const TEXT_LIMIT = 200;
const COMMAND_LIMIT = 300;

const withoutControls = text => text.replace(/[\u0000-\u001f\u007f]/g, '');

/** Quotes one word for the device's shell, like Python's shlex.quote. */
function shellQuote(text) {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** The shell command that types `text`, or null if nothing is left to type. */
function textCommand(text) {
  if (typeof text !== 'string') return null;
  const clean = withoutControls(text).slice(0, TEXT_LIMIT);
  if (!clean) return null;
  return `input text ${shellQuote(clean.replaceAll(' ', '%s'))}`;
}

/** True for a command a device may keep: one line of reasonable length, or nothing. */
function isValidCommand(command) {
  return typeof command === 'string' && command.length <= COMMAND_LIMIT && withoutControls(command) === command;
}

module.exports = { KEYS, TEXT_LIMIT, isValidCommand, shellQuote, textCommand };
