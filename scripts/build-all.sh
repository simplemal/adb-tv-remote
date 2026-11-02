#!/usr/bin/env bash
# Builds the app for macOS, Windows and Linux, or only macOS with "mac", and puts the results in dist/. The build runs outside
# the project: signing fails inside folders managed by iCloud or Dropbox.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT:?}"' EXIT
cd "$ROOT"

npm run prepare:bin
if [ "${1:-}" != mac ]; then
  TARGET_PLATFORM=win32 TARGET_ARCH=x64 node scripts/fetch-adb.mjs
  TARGET_PLATFORM=linux TARGET_ARCH=x64 node scripts/fetch-adb.mjs
  node scripts/fetch-ffmpeg.mjs
fi

# A Developer ID certificate in the keychain signs the Mac app, and a notarytool profile saved as
# "notarize" gets it notarized, which takes minutes, so "mac" alone skips it and "mac notarize" does
# not. Without them the build has an ad-hoc signature, as for anyone else.
MAC_SIGNING=()
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"Developer ID Application: \(.*\)"/\1/p' | head -1)"
if [ -n "$IDENTITY" ]; then
  MAC_SIGNING=(-c.mac.identity="$IDENTITY" -c.mac.hardenedRuntime=true)
  if [ "${1:-}" = mac ] && [ "${2:-}" != notarize ]; then
    # Asking Apple for the time of each file is most of the wait, and only notarization needs it.
    MAC_SIGNING+=(-c.mac.timestamp=none)
    echo "Signed, not notarized: quick build."
  elif xcrun notarytool history --keychain-profile notarize >/dev/null 2>&1; then
    export APPLE_KEYCHAIN_PROFILE=notarize
  else
    echo "No notarytool profile named notarize: signed, not notarized."
  fi
fi

npx electron-builder --mac --arm64 -c.directories.output="$OUT" ${MAC_SIGNING[@]+"${MAC_SIGNING[@]}"}
if [ "${1:-}" != mac ]; then
  npx electron-builder --win --x64 -c.directories.output="$OUT"
  npx electron-builder --linux --x64 -c.directories.output="$OUT"
fi

mkdir -p dist
# A server left running would outlive the copy of the app it belongs to.
ANDROID_ADB_SERVER_PORT="$(node -p "require('./src/main/adb').SERVER_PORT")" \
  "resources/bin/$(node -p 'process.platform + "-" + process.arch')/adb" kill-server 2>/dev/null || true
ditto "$OUT/mac-arm64/ADB TV Remote.app" "dist/mac-arm64/ADB TV Remote.app.new"
rm -rf "dist/mac-arm64/ADB TV Remote.app"
mv "dist/mac-arm64/ADB TV Remote.app.new" "dist/mac-arm64/ADB TV Remote.app"
find "$OUT" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' \) -exec cp {} dist/ \;
ls -lh dist | grep -E '\.(dmg|exe|AppImage|deb)$'
