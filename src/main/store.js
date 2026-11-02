'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isValidAddress } = require('./adb');
const { isValidCommand } = require('./keys');

const DEFAULTS = { devices: [], selected: '', language: 'auto' };

/** Saved devices and preferences, in one small JSON file only this user can read. */
class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS, devices: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.devices)) {
        // Addresses reach adb's arguments and commands the device's shell, so the file is not trusted.
        this.data.devices = saved.devices.filter(device => isValidAddress(device?.address))
          .map(({ address, name, menuHold, homeCommand }) => ({
            address,
            name: typeof name === 'string' ? name : '',
            menuHold: isValidCommand(menuHold) ? menuHold : '',
            homeCommand: isValidCommand(homeCommand) ? homeCommand : '',
          }));
      }
      if (typeof saved.language === 'string') this.data.language = saved.language;
      if (this.find(saved.selected)) this.data.selected = saved.selected;
    } catch {
      // No file yet, or a damaged one: start clean.
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const draft = `${this.file}.tmp`;
    fs.writeFileSync(draft, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(draft, this.file);
  }

  get devices() {
    return this.data.devices;
  }

  get language() {
    return this.data.language;
  }

  set language(language) {
    this.data.language = language;
    this.save();
  }

  find(address) {
    return this.data.devices.find(device => device.address === address);
  }

  /** The device in use: the chosen one, or null. */
  get selected() {
    return this.find(this.data.selected) ?? null;
  }

  add(address) {
    if (!this.find(address)) this.data.devices.push({ address, name: '', menuHold: '', homeCommand: '' });
    this.data.selected = address;
    this.save();
  }

  select(address) {
    if (!this.find(address)) return false;
    this.data.selected = address;
    this.save();
    return true;
  }

  rename(address, name) {
    const device = this.find(address);
    if (device) {
      device.name = name;
      this.save();
    }
  }

  /** A shell command this device runs instead of a key: `menuHold` or `homeCommand`. */
  setCommand(address, field, command) {
    const device = this.find(address);
    if (device) {
      device[field] = command;
      this.save();
    }
  }

  remove(address) {
    this.data.devices = this.data.devices.filter(device => device.address !== address);
    if (this.data.selected === address) this.data.selected = this.data.devices[0]?.address ?? '';
    this.save();
  }
}

module.exports = { Store };
