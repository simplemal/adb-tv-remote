'use strict';
const net = require('node:net');
const os = require('node:os');
const { DEFAULT_PORT } = require('./adb');

/** A device on Wi-Fi the computer has never talked to can take over a second to answer. */
const PROBE_TIMEOUT_MS = 1500;
const CONCURRENCY = 96;
const MAX_NETWORKS = 4;
/** Larger networks would take minutes to search, so there only the computer's own 256 are tried. */
const WIDEST_MASK_BITS = 22;

function isPrivate([a, b]) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function maskBits(netmask = '255.255.255.0') {
  return netmask.split('.').reduce((bits, part) => bits + Number(part).toString(2).replaceAll('0', '').length, 0);
}

/** Each group of 256 addresses on the network of `parts`, its own first, as "192.168.1". */
function groups([a, b, c], bits) {
  if (bits < WIDEST_MASK_BITS || bits >= 24) return [`${a}.${b}.${c}`];
  const size = 2 ** (24 - bits);
  const first = c - (c % size);
  const others = Array.from({ length: size }, (_, i) => first + i).filter(group => group !== c);
  return [c, ...others].map(group => `${a}.${b}.${group}`);
}

/**
 * The first three parts of the addresses on this computer's private networks. A network can span
 * several groups of 256: a TV on 192.168.1.x and a computer on 192.168.0.x can be neighbours. A
 * point-to-point link, as a VPN has, has no neighbours to find.
 */
function localNetworks(interfaces = os.networkInterfaces()) {
  const networks = new Set();
  for (const addresses of Object.values(interfaces)) {
    for (const { family, internal, address, netmask } of addresses ?? []) {
      const parts = address.split('.').map(Number);
      const bits = maskBits(netmask);
      if (family !== 'IPv4' || internal || !isPrivate(parts) || bits >= 31) continue;
      for (const group of groups(parts, bits)) networks.add(group);
    }
  }
  return [...networks].slice(0, MAX_NETWORKS);
}

/**
 * "open" if something accepts a TCP connection, "alive" if a device answers and refuses, "none"
 * if nothing answers. Nothing is sent, and it closes at once.
 */
function probe(host, port = DEFAULT_PORT, timeout = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout });
    const finish = answer => { socket.destroy(); resolve(answer); };
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('none'));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'alive' : 'none'));
  });
}

/**
 * `found`: addresses on the local networks with the ADB port open. `seen`: how many devices answered
 * at all, which tells a TV that is missing from a computer that cannot reach its network, as when
 * macOS has not allowed Local Network. Only runs when the user asks.
 */
async function scan({ networks = localNetworks(), test = probe } = {}) {
  const hosts = networks.flatMap(network => Array.from({ length: 254 }, (_, i) => `${network}.${i + 1}`));
  const found = [];
  let seen = 0;
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const answer = await test(host);
      if (answer === 'open') found.push(host);
      if (answer !== 'none') seen += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { found: found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), seen, networks };
}

module.exports = { localNetworks, probe, scan };
