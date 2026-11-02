'use strict';
const { spawn } = require('node:child_process');

const VIDEO_SIZE = '960x540';
const VIDEO_BITRATE = '4000000';
const START_OF_JPEG = Buffer.from([0xff, 0xd8]);
const END_OF_JPEG = Buffer.from([0xff, 0xd9]);
const BUFFER_LIMIT = 16 * 1024 * 1024;
const QUIET_MS = 150;
/** Long enough for the device's own transition after a key to end. */
const SECOND_LOOK_MS = 400;
/** The encoder keeps the latest change until the next one: nothing else would show it. */
const REFRESH_MS = 3000;
const SETTLE_STEP_MS = 100;
const SETTLE_LIMIT_MS = 12000;
const SETTLE_TRIES = 3;
const STALE_FRAMES = 3;
const SHORT_RUN_MS = 2000;
const NO_DEVICE_MS = 2000;
const SCREENSHOT_TIMEOUT_MS = 8000;
const SCREENSHOT_EVERY_MS = 500;
const RETRY_MS = 1000;
const RETRY_LIMIT_MS = 30000;

/** Tested on real devices. In particular, `-fflags nobuffer` must stay out: with it the
 *  decoder produces nothing. Without `yuvj420p` the MJPEG encoder fails. */
const RECORD_ARGS = ['exec-out', 'screenrecord', '--output-format=h264',
  '--size', VIDEO_SIZE, '--bit-rate', VIDEO_BITRATE, '-'];
const DECODE_ARGS = ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay', '-threads', '1',
  '-probesize', '2048', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0',
  '-fps_mode', 'passthrough', '-pix_fmt', 'yuvj420p', '-threads', '1',
  '-f', 'mjpeg', '-q:v', '5', '-flush_packets', '1', 'pipe:1'];

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Cuts a byte stream into whole JPEG images. */
class JpegSplitter {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const start = this.buffer.indexOf(START_OF_JPEG);
      const end = start < 0 ? -1 : this.buffer.indexOf(END_OF_JPEG, start + 2);
      if (end < 0) break;
      frames.push(this.buffer.subarray(start, end + 2));
      this.buffer = this.buffer.subarray(end + 2);
    }
    if (this.buffer.length > BUFFER_LIMIT) this.buffer = Buffer.alloc(0);
    return frames;
  }
}

/**
 * The device's screen. Runs only while someone is looking: JPEGs from its video encoder, which
 * emits only on change and stops after 3 minutes, and screenshots to start and to settle.
 */
class ScreenCapture {
  constructor({ adb, ffmpegPath, connectedTarget, knownTarget, quickShot, publish }) {
    this.adb = adb;
    this.quickShot = quickShot;
    this.ffmpegPath = ffmpegPath;
    this.connectedTarget = connectedTarget;
    this.knownTarget = knownTarget;
    this.publish = publish;
    this.watching = false;
    this.controller = null;
    this.lastVideo = 0;
    this.lastKey = 0;
    this.settling = false;
    this.staleFrames = 0;
    this.refreshTimer = null;
  }

  setWatching(watching) {
    if (watching === this.watching) return;
    this.watching = watching;
    if (watching) this.start();
    else this.stop();
  }

  start() {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    this.loop(controller.signal).catch(() => {});
    this.refreshTimer = setInterval(() => this.refresh(controller.signal).catch(() => {}), REFRESH_MS);
  }

  stop() {
    clearInterval(this.refreshTimer);
    this.controller?.abort();
    this.controller = null;
  }

  /** Only with the helper: screencap every few seconds would be far too much for the device. */
  async refresh(signal) {
    const name = this.knownTarget();
    if (!name || this.settling || Date.now() - this.lastVideo < REFRESH_MS) return;
    const asked = Date.now();
    const quick = await this.quickShot?.(name);
    if (quick && !signal.aborted && !this.settling && this.lastVideo < asked) {
      this.staleFrames = STALE_FRAMES;
      this.publish(quick, 'image/jpeg');
    }
  }

  /** Drops the current device's capture and starts on the new one. */
  restart() {
    if (this.watching) this.start();
  }

  /** From the helper on the device if it can: screencap takes seconds over a network. */
  async screenshot(name, signal) {
    const quick = await this.quickShot?.(name);
    if (quick) return { data: quick, kind: 'image/jpeg' };
    if (signal?.aborted) return null;
    const { stdout } = await this.adb.run(['-s', name, 'exec-out', 'screencap', '-p'],
      { timeout: SCREENSHOT_TIMEOUT_MS, signal });
    return stdout.subarray(0, 4).toString('latin1') === '\x89PNG' ? { data: stdout, kind: 'image/png' } : null;
  }

  /** Follows the controller's checks without asking for any: it is restarted when a device
   *  arrives. A screenshot starts the picture, and stands in for a recording that could not
   *  run. A recording that keeps failing is tried less and less often. */
  async loop(signal) {
    let needsPicture = true;
    let retry = RETRY_MS;
    while (!signal.aborted) {
      const name = this.knownTarget();
      if (!name) {
        await sleep(NO_DEVICE_MS, signal);
        continue;
      }
      if (needsPicture) {
        const first = await this.screenshot(name, signal);
        if (first && !signal.aborted) this.publish(first.data, first.kind);
      }
      if (!this.ffmpegPath) {
        await sleep(SCREENSHOT_EVERY_MS, signal);
        continue;
      }
      const started = Date.now();
      await this.video(name, signal);
      needsPicture = Date.now() - started < SHORT_RUN_MS;
      if (needsPicture) {
        await sleep(retry, signal);
        retry = Math.min(retry * 2, RETRY_LIMIT_MS);
      } else {
        retry = RETRY_MS;
      }
    }
  }

  video(name, signal) {
    return new Promise(resolve => {
      if (signal.aborted) { resolve(); return; }
      const record = this.adb.spawn(['-s', name, ...RECORD_ARGS], ['ignore', 'pipe', 'ignore']);
      const decode = spawn(this.ffmpegPath, DECODE_ARGS, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const splitter = new JpegSplitter();
      const kill = () => { record.kill('SIGKILL'); decode.kill('SIGKILL'); };
      const finish = () => {
        signal.removeEventListener('abort', kill);
        kill();
        resolve();
      };
      signal.addEventListener('abort', kill, { once: true });
      record.once('error', kill);
      record.once('close', () => decode.stdin.end());
      decode.once('error', finish);
      decode.once('close', finish);
      decode.stdin.on('error', () => {});
      record.stdout.on('error', () => {});
      record.stdout.pipe(decode.stdin);
      decode.stdout.on('data', chunk => {
        for (const frame of splitter.push(chunk)) this.videoFrame(frame, signal);
      });
    });
  }

  videoFrame(frame, signal) {
    this.lastVideo = Date.now();
    if (this.staleFrames > 0) {
      this.staleFrames -= 1;
      return;
    }
    if (!signal.aborted) this.publish(Buffer.from(frame), 'image/jpeg');
  }

  /** A key or a touch was sent. See settle(). A touch can change the page in a single frame,
   *  so it must not be taken for a stale one. */
  noteKey(touch = false) {
    this.lastKey = Date.now();
    if (touch) this.staleFrames = 0;
    if (!this.settling) {
      this.settling = true;
      this.settle().catch(() => {}).finally(() => { this.settling = false; });
    }
  }

  /** Waits for keys and video to stop. False if the video is still moving at the limit. */
  async quiet() {
    for (;;) {
      await sleep(SETTLE_STEP_MS);
      const sinceKey = Date.now() - this.lastKey;
      if (sinceKey >= QUIET_MS && Date.now() - this.lastVideo >= QUIET_MS) return true;
      if (sinceKey >= SETTLE_LIMIT_MS) return false;
    }
  }

  /** The video stops on a still screen, possibly mid-transition, so once it has gone quiet a
   *  screenshot makes sure the page ends on what the device really shows. While it keeps moving
   *  it shows that by itself, and a screenshot, the heaviest thing asked of the device, would
   *  only be thrown away.
   *
   *  A screenshot is older than anything that happened while it was being taken, so it is
   *  thrown away if a key or a frame came meanwhile: shown, it would move the picture back.
   *  The encoder also still holds the last frames from before it, and hands them over at the
   *  next change: those are skipped for the same reason. */
  async settle() {
    let handled;
    let tries = 0;
    let settled = false;
    let secondLook = false;
    do {
      tries += 1;
      const quiet = await this.quiet();
      handled = this.lastKey;
      if (!quiet || !this.watching) return;
      const name = await this.connectedTarget();
      const signal = this.controller?.signal;
      const asked = Date.now();
      const frame = name && await this.screenshot(name, signal);
      if (frame && !signal?.aborted && this.lastKey === handled && this.lastVideo < asked) {
        this.staleFrames = STALE_FRAMES;
        this.publish(frame.data, frame.kind);
        settled = true;
      }
      if (settled && frame.kind === 'image/jpeg' && !secondLook) {
        secondLook = true;
        settled = false;
        await sleep(SECOND_LOOK_MS);
      }
    } while (this.lastKey !== handled || (!settled && tries < SETTLE_TRIES));
  }
}

module.exports = { ScreenCapture, JpegSplitter, RECORD_ARGS, DECODE_ARGS };
