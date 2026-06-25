#!/usr/bin/env bash
# Fetches the upstream codec patch baselines into electron-codecs/upstream/.
# Run from the repo root on the build machine (normal network access required):
#   bash electron-codecs/fetch-baseline.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
upstream="$root/upstream"
mkdir -p "$upstream"

# 5rahim: HEVC + AC3 + E-AC3 patches (baseline = Electron 36.2.1 / ~Chromium 136)
[ -d "$upstream/electron-media-patch" ] || \
  git clone --depth 1 https://github.com/5rahim/electron-media-patch.git "$upstream/electron-media-patch"

# ThaUnknown: older alternative patch set (up to v29.1.4) for cross-reference
[ -d "$upstream/electron-chromium-codecs" ] || \
  git clone --depth 1 https://github.com/ThaUnknown/electron-chromium-codecs.git "$upstream/electron-chromium-codecs"

# StaZhu helper that compiles the HEVC parser + AC3/E-AC3 decoders into FFmpeg
curl -fsSL \
  https://raw.githubusercontent.com/StaZhu/enable-chromium-hevc-hardware-decoding/main/add-hevc-ffmpeg-decoder-parser.js \
  -o "$upstream/add-hevc-ffmpeg-decoder-parser.js"

# Seed patches/ with the 5rahim originals if not already ported
mkdir -p "$root/patches"
for f in "$upstream"/electron-media-patch/patches/*.patch; do
  dest="$root/patches/$(basename "$f")"
  [ -e "$dest" ] || cp "$f" "$dest"
done

echo "Baseline fetched into electron-codecs/upstream/. Ported patches go in electron-codecs/patches/."
