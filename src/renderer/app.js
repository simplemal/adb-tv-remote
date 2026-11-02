'use strict';
/* global STRINGS, tvRemote */
const HOLD_MS = 2000;
const ECHO_MS = 180;
const ECHO_HELD_MS = 800;
const MIN_ZOOM = 0.6;
const LOADING_NOTE_MS = 4000;
const TOUCH_MOVE_MS = 30;
const KEYBOARD = {
  ArrowUp: 'DPAD_UP', ArrowDown: 'DPAD_DOWN', ArrowLeft: 'DPAD_LEFT', ArrowRight: 'DPAD_RIGHT',
  Enter: 'DPAD_CENTER', Escape: 'BACK', Backspace: 'BACK', h: 'HOME', m: 'MENU', ' ': 'MEDIA_PLAY_PAUSE',
};

/** Sizes the style sheet owns. */
const cssSize = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
const REMOTE_WIDTH = cssSize('--remote-width');
const REMOTE_HEIGHT = cssSize('--remote-height');
const GAP = cssSize('--gap');
const PAGE_EDGE = 2 * cssSize('--page-pad');

const byId = id => document.getElementById(id);
const remote = byId('remote');
const cards = document.querySelectorAll('.card');
const guide = byId('guide');
const screenView = byId('screen');
const emptyView = byId('empty');
const touchDot = byId('touch-dot');
const addressField = byId('address');
const commandFields = document.querySelectorAll('[data-command]');

let powerPressed = null;
let state = { status: 'connecting', reason: '', selected: '', devices: [], language: 'auto', smoothVideo: true };
let words = STRINGS.en;
let language = null;
let showing = false;
let pictureTimer = null;
const echoTimers = new Map();
let frameUrl = null;
let guideStep = 1;
let touchPointer = null;
let lastTouchMove = 0;

const t = key => words[key] ?? STRINGS.en[key] ?? key;

function applyLanguage() {
  const wanted = state.language === 'auto' ? navigator.language.slice(0, 2) : state.language;
  const next = STRINGS[wanted] ? wanted : 'en';
  if (next === language) return;
  language = next;
  words = STRINGS[language];
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
}

/** The remote takes the height of the video beside it; both shrink to stay in the window. The
 *  style sheet decides when the page is too narrow for that and stacks them. */
function fitLayout() {
  if (getComputedStyle(document.body).flexDirection === 'column') {
    remote.style.zoom = 1;
    document.documentElement.style.removeProperty('--video');
    for (const card of cards) card.style.removeProperty('right');
    return;
  }
  const width = innerWidth - PAGE_EDGE - GAP;
  const height = innerHeight - PAGE_EDGE;
  const matching = (width * 9 / 16) / (REMOTE_HEIGHT + REMOTE_WIDTH * 9 / 16);
  const zoom = Math.max(MIN_ZOOM, Math.min(matching, height / REMOTE_HEIGHT));
  remote.style.zoom = zoom;
  const video = Math.min(width - REMOTE_WIDTH * zoom, height * 16 / 9);
  document.documentElement.style.setProperty('--video', `${Math.round(video)}px`);
  for (const card of cards) card.style.right = `${Math.round(PAGE_EDGE / 2 + GAP + REMOTE_WIDTH * zoom)}px`;
}
addEventListener('resize', fitLayout);
fitLayout();

function closeCards() {
  for (const card of cards) card.hidden = true;
  for (const button of document.querySelectorAll('[aria-expanded]')) button.setAttribute('aria-expanded', 'false');
}

function bindCard(buttonId, cardId, fieldId) {
  const button = byId(buttonId);
  const card = byId(cardId);
  button.addEventListener('click', () => {
    const open = card.hidden;
    closeCards();
    card.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) byId(fieldId).focus();
  });
  const close = () => {
    card.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  };
  card.querySelector('.close').addEventListener('click', close);
  card.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });
}
for (const field of commandFields) {
  field.addEventListener('change', () => tvRemote.setCommand(field.dataset.command, field.value));
}
bindCard('open-devices', 'device-card', 'address');
bindCard('open-text', 'text-card', 'text');

for (const button of document.querySelectorAll('[data-key]')) {
  const key = button.dataset.key;
  const canHold = 'hold' in button.dataset;
  let timer = null;
  let pressed = false;
  let pressedAt = 0;
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('pressed');
    pressed = true;
    if (key === 'POWER' && state.status === 'connected') {
      powerPressed = state.power === 'asleep' ? 'aboutToWake' : 'aboutToSleep';
      showPower();
    }
    pressedAt = performance.now();
    if (canHold) timer = setTimeout(() => button.classList.add('held'), HOLD_MS);
  });
  // Decided on release, by the clock: a timer can run late while the window is covered.
  const release = send => {
    if (!pressed) return;
    pressed = false;
    button.classList.remove('pressed', 'held');
    clearTimeout(timer);
    if (key === 'POWER') {
      powerPressed = null;
      showPower();
    }
    if (send) tvRemote.sendKey(key, canHold && performance.now() - pressedAt >= HOLD_MS);
  };
  button.addEventListener('pointerup', () => release(true));
  button.addEventListener('pointercancel', () => release(false));
  button.addEventListener('click', event => { if (event.detail === 0) tvRemote.sendKey(key, false); });
}

addEventListener('keydown', event => {
  if (!guide.hidden || ['INPUT', 'SELECT'].includes(event.target.tagName) || event.metaKey || event.ctrlKey) return;
  const key = KEYBOARD[event.key];
  if (!key) return;
  event.preventDefault();
  tvRemote.sendKey(key, false);
  const button = document.querySelector(`[data-key="${key}"]`);
  button.classList.add('pressed');
  setTimeout(() => button.classList.remove('pressed'), 120);
});

byId('write').addEventListener('submit', event => {
  event.preventDefault();
  const field = byId('text');
  if (field.value) tvRemote.sendText(field.value);
  field.value = '';
});

/** A power key takes seconds and leaves the picture black, so say what is going on. */
function showPower() {
  const note = powerPressed || (state.status === 'connected' && state.power !== 'awake' ? state.power : null);
  byId('power-note').hidden = !note;
  if (!note) return;
  byId('power-title').textContent = t(`power.${note}.title`);
  byId('power-text').textContent = t(`power.${note}.text`);
  byId('power-note').classList.toggle('waiting', note !== 'asleep');
}

/** adb's words when nothing answers at that address, whether or not ADB debugging is on. */
const SILENT = /^timeout$|timed out|host is down|no route to host|host unreachable/i;

/** The explanation, with adb's own words when it could not reach the device. */
function emptyText(status) {
  if (status !== 'unreachable' || !state.reason) return t(`empty.${status}.text`);
  const text = t(SILENT.test(state.reason) ? 'empty.silent.text' : 'empty.unreachable.text');
  return `${text} ${t('reason.label')} ${state.reason === 'timeout' ? t('reason.timeout') : state.reason}`;
}

function showEmpty(status) {
  byId('empty-title').textContent = t(`empty.${status}.title`);
  byId('empty-text').textContent = emptyText(status);
  byId('get-adb').hidden = status !== 'no-adb';
  emptyView.classList.toggle('waiting', status === 'connected' || status === 'connecting');
  emptyView.hidden = false;
}

const pictureArrived = () => {
  clearTimeout(pictureTimer);
  emptyView.hidden = true;
};

function showScreen(status) {
  const on = status === 'connected';
  if (!on) showEmpty(status);
  if (on === showing) return;
  showing = on;
  clearTimeout(pictureTimer);
  if (on) {
    showEmpty(status);
    pictureTimer = setTimeout(pictureArrived, LOADING_NOTE_MS);
  } else {
    screenView.removeAttribute('src');
  }
}

/** Frames are shown one at a time: the next is sent only after this one is on screen. */
/** A key pressed on any remote shows here too, for long enough to be seen. */
tvRemote.onKeyEcho((key, down) => {
  const button = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!button) return;
  clearTimeout(echoTimers.get(button));
  if (down) button.classList.add('pressed');
  // Not every release reaches the device's log: a key must not stay lit for ever.
  echoTimers.set(button, setTimeout(() => button.classList.remove('pressed'), down ? ECHO_HELD_MS : ECHO_MS));
});

tvRemote.onFrame(({ data, kind }) => {
  if (!showing) {
    tvRemote.frameShown();
    return;
  }
  const previous = frameUrl;
  frameUrl = URL.createObjectURL(new Blob([data], { type: kind }));
  screenView.src = frameUrl;
  if (previous) URL.revokeObjectURL(previous);
});
screenView.addEventListener('load', () => {
  if (screenView.getAttribute('src')) pictureArrived();
  tvRemote.frameShown();
});
screenView.addEventListener('error', () => tvRemote.frameShown());

/** A click on the picture is a touch on the device: hold for a long press, drag to scroll. */
function sendTouch(action, event) {
  if (action === 'move' && event.timeStamp - lastTouchMove < TOUCH_MOVE_MS) return;
  lastTouchMove = event.timeStamp;
  const box = screenView.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
  touchDot.style.left = `${x * 100}%`;
  touchDot.style.top = `${y * 100}%`;
  tvRemote.sendTouch(action, x, y);
}

function endTouch(event) {
  if (event.pointerId !== touchPointer) return;
  touchPointer = null;
  sendTouch('up', event);
  touchDot.classList.remove('active');
}

screenView.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !screenView.getAttribute('src')) return;
  event.preventDefault();
  touchPointer = event.pointerId;
  screenView.setPointerCapture(touchPointer);
  sendTouch('down', event);
  touchDot.classList.add('active');
});
screenView.addEventListener('pointermove', event => {
  if (event.pointerId === touchPointer) sendTouch('move', event);
});
screenView.addEventListener('pointerup', endTouch);
screenView.addEventListener('pointercancel', endTouch);

function deviceLine(device) {
  const line = document.createElement('li');
  line.classList.toggle('current', device.address === state.selected);
  const pick = document.createElement('button');
  pick.className = 'pick';
  pick.type = 'button';
  const title = document.createElement('b');
  title.textContent = device.name || device.address;
  pick.append(title);
  if (device.name) {
    const address = document.createElement('small');
    address.textContent = device.address;
    pick.append(address);
  }
  pick.addEventListener('click', () => tvRemote.selectDevice(device.address));
  const forget = document.createElement('button');
  forget.className = 'forget';
  forget.type = 'button';
  forget.textContent = '×';
  forget.setAttribute('aria-label', `${t('action.forget')} ${device.name || device.address}`);
  forget.addEventListener('click', () => tvRemote.removeDevice(device.address));
  line.append(pick, forget);
  return line;
}

function showDevices() {
  const list = byId('devices');
  list.replaceChildren(...state.devices.map(deviceLine));
  list.hidden = state.devices.length === 0;
}

function guideOutcome() {
  const done = state.status === 'connected';
  byId('guide-outcome').textContent = done ? t('guide.connected') : t(`empty.${state.status}.title`);
  byId('guide-outcome-text').textContent = done ? '' : t(`empty.${state.status}.text`);
  byId('guide-next').disabled = guideStep === 3 && !done;
}

function renderGuide() {
  byId('guide-step').textContent = t('guide.step').replace('{step}', guideStep);
  for (const section of guide.querySelectorAll('[data-step]')) section.hidden = Number(section.dataset.step) !== guideStep;
  byId('guide-back').hidden = guideStep === 1;
  byId('guide-next').hidden = guideStep === 2;
  byId('guide-next').textContent = t(guideStep === 3 ? 'action.done' : 'action.next');
  guideOutcome();
}

function showGuideStep(step) {
  guideStep = step;
  renderGuide();
  if (step === 2) byId('guide-address').focus();
}

function openGuide() {
  closeCards();
  guide.hidden = false;
  byId('guide-invalid').hidden = true;
  showGuideStep(1);
}

async function connectFromGuide(address) {
  const accepted = await tvRemote.addDevice(address);
  byId('guide-invalid').hidden = accepted;
  if (accepted) showGuideStep(3);
}

byId('open-guide').addEventListener('click', openGuide);
byId('guide-skip').addEventListener('click', () => { guide.hidden = true; });
byId('guide-back').addEventListener('click', () => showGuideStep(guideStep - 1));
byId('guide-next').addEventListener('click', () => {
  if (guideStep === 3) guide.hidden = true;
  else showGuideStep(guideStep + 1);
});
byId('guide-connect').addEventListener('submit', event => {
  event.preventDefault();
  connectFromGuide(byId('guide-address').value);
});

/** What a search that found no TV can say about why. */
function nothingFound({ seen, networks }) {
  if (networks.length === 0) return t('found.noNetwork');
  const key = seen > 0 ? 'found.others' : 'found.blocked';
  return t(key).replace('{networks}', networks.map(network => `${network}.x`).join(', ')).replace('{seen}', seen);
}

/** Looks for devices and lists them in `list`; choosing one calls `choose`. */
function bindFind(buttonId, listId, choose) {
  const button = byId(buttonId);
  const list = byId(listId);
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = t('action.finding');
    const result = await tvRemote.findDevices();
    const { found } = result;
    button.disabled = false;
    button.textContent = t('action.find');
    list.hidden = false;
    list.replaceChildren(...found.map(address => {
      const line = document.createElement('li');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = address;
      pick.addEventListener('click', () => { list.hidden = true; choose(address); });
      line.append(pick);
      return line;
    }));
    if (found.length === 0) {
      const line = document.createElement('li');
      line.className = 'note';
      line.textContent = nothingFound(result);
      list.append(line);
    }
  });
}
bindFind('find', 'found', address => tvRemote.addDevice(address));
bindFind('guide-find', 'guide-found', connectFromGuide);

byId('connect').addEventListener('submit', async event => {
  event.preventDefault();
  addressField.blur();
  closeCards();
  if (await tvRemote.addDevice(addressField.value)) addressField.value = '';
});
byId('language').addEventListener('change', event => tvRemote.setLanguage(event.target.value));
byId('get-adb').addEventListener('click', () => tvRemote.openAdbHelp());

function show(next) {
  state = next;
  applyLanguage();
  byId('status').textContent = t(`status.${state.status}`);
  byId('light').classList.toggle('ok', state.status === 'connected');
  byId('language').value = state.language;
  byId('no-ffmpeg').hidden = state.smoothVideo;
  showDevices();
  showScreen(state.status);
  showPower();
  const device = state.devices.find(({ address }) => address === state.selected);
  for (const field of commandFields) {
    if (document.activeElement !== field) field.value = device?.[field.dataset.command] ?? '';
    field.disabled = !device;
  }
  renderGuide();
}

/** While the window cannot be seen, nothing is asked of the device. */
const reportVisibility = () => tvRemote.setVisible(!document.hidden);
document.addEventListener('visibilitychange', reportVisibility);

tvRemote.onState(show);
reportVisibility();
tvRemote.getState().then(first => {
  show(first);
  if (first.devices.length === 0 && first.status !== 'no-adb') openGuide();
});
