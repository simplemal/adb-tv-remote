#!/usr/bin/env bash
# Builds the small LGPL FFmpeg the app ships: H.264 in, Motion JPEG out, nothing else.
# Run on the operating system you are packaging for. Needs a C compiler and make; nasm on x86.
set -euo pipefail

VERSION="8.1.3"
SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="$(node -p process.platform)"
ARCH="$(node -p process.arch)"
OUT="$ROOT/resources/bin/$PLATFORM-$ARCH"
CACHE="$ROOT/.cache/ffmpeg"
TARBALL="$CACHE/ffmpeg-$VERSION.tar.xz"

if [ -x "$OUT/ffmpeg" ] || [ -x "$OUT/ffmpeg.exe" ]; then
  echo "FFmpeg already built in $OUT"
  exit 0
fi

mkdir -p "$CACHE" "$OUT"
[ -f "$TARBALL" ] || curl -fL --retry 3 -o "$TARBALL" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
if command -v sha256sum >/dev/null; then CHECK=(sha256sum); else CHECK=(shasum -a 256); fi
echo "$SHA256  $TARBALL" | "${CHECK[@]}" -c -

rm -rf "$CACHE/src"
mkdir -p "$CACHE/src"
tar -xJf "$TARBALL" -C "$CACHE/src" --strip-components=1
cd "$CACHE/src"

# No --enable-gpl and no --enable-nonfree: the result stays under the LGPL.
CONFIGURE=(
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-network --disable-ffplay --disable-ffprobe --disable-avdevice
  --disable-swresample --enable-small --enable-static --disable-shared
  --enable-protocol=pipe --enable-demuxer=h264 --enable-parser=h264 --enable-decoder=h264
  --enable-encoder=mjpeg --enable-muxer=mjpeg
  --enable-filter=buffer,buffersink,format,null,scale
)
command -v nasm >/dev/null || CONFIGURE+=(--disable-x86asm)
./configure "${CONFIGURE[@]}"
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" ffmpeg

BINARY=ffmpeg
[ -f ffmpeg.exe ] && BINARY=ffmpeg.exe
cp "$BINARY" "$OUT/$BINARY"
strip "$OUT/$BINARY" 2>/dev/null || true
cp COPYING.LGPLv2.1 "$OUT/FFmpeg-LICENSE.txt"
cat > "$OUT/FFmpeg-BUILD-INFO.txt" <<INFO
FFmpeg $VERSION, built without changes to its source.
Source: https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz
SHA-256: $SHA256
Configure line: ./configure ${CONFIGURE[*]}
INFO
echo "Built $OUT/$BINARY"
"$OUT/$BINARY" -hide_banner -version | sed -n '1p'
