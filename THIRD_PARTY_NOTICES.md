# Third-party notices

ADB TV Remote's own code is under the MIT License (see `LICENSE`). Packaged builds also contain
the programs below, each under its own license.

## FFmpeg

- **License:** GNU Lesser General Public License, version 2.1 or later. The license text ships
  next to the program as `bin/FFmpeg-LICENSE.txt`.
- **Version:** 8.1.3, built without changes to its source, without `--enable-gpl` and without
  `--enable-nonfree`. The exact configure line ships as `bin/FFmpeg-BUILD-INFO.txt` and is in
  `scripts/build-ffmpeg.sh`.
- **Source:** <https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz>
- FFmpeg is a separate program. The app runs it and reads its output, and does not link to it, so
  you can replace it: set `ADB_TV_REMOTE_FFMPEG` to another build's path.

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the
[LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).

H.264 may be covered by patents in some countries. FFmpeg's own
[legal page](https://ffmpeg.org/legal.html) explains the position.

## Android Debug Bridge (adb)

- **License:** Apache License 2.0. `bin/adb-NOTICE.txt` holds the notices that Google ships with it.
- **Version:** platform-tools 37.0.1, Google's unmodified binary.
- **Source:** <https://android.googlesource.com/platform/packages/modules/adb/>

Google's Android SDK terms leave open-source components to their own licenses (section 3.5).

## Electron and Chromium

- **License:** MIT for Electron. Packaged builds include `LICENSE` and `LICENSES.chromium.html`
  with the notices for Chromium and its components.
- **Source:** <https://github.com/electron/electron>

## Trademarks

Fire TV is a trademark of Amazon. Android, Android TV and Google TV are trademarks of Google.
This project is not affiliated with or endorsed by either company.
