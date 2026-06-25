# Fetches the upstream codec patch baselines into electron-codecs/upstream/.
# Run from the repo root on the build machine (normal network access required):
#   pwsh electron-codecs/fetch-baseline.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$upstream = Join-Path $root "upstream"
New-Item -ItemType Directory -Force -Path $upstream | Out-Null

# 5rahim: HEVC + AC3 + E-AC3 patches (baseline = Electron 36.2.1 / ~Chromium 136)
if (-not (Test-Path (Join-Path $upstream "electron-media-patch"))) {
  git clone --depth 1 https://github.com/5rahim/electron-media-patch.git (Join-Path $upstream "electron-media-patch")
}

# ThaUnknown: older alternative patch set (up to v29.1.4) for cross-reference
if (-not (Test-Path (Join-Path $upstream "electron-chromium-codecs"))) {
  git clone --depth 1 https://github.com/ThaUnknown/electron-chromium-codecs.git (Join-Path $upstream "electron-chromium-codecs")
}

# StaZhu helper that compiles the HEVC parser + AC3/E-AC3 decoders into FFmpeg
$staZhu = "https://raw.githubusercontent.com/StaZhu/enable-chromium-hevc-hardware-decoding/main/add-hevc-ffmpeg-decoder-parser.js"
Invoke-WebRequest -Uri $staZhu -OutFile (Join-Path $upstream "add-hevc-ffmpeg-decoder-parser.js")

# Seed patches/ with the 5rahim originals if not already ported
$patches = Join-Path $root "patches"
New-Item -ItemType Directory -Force -Path $patches | Out-Null
Get-ChildItem (Join-Path $upstream "electron-media-patch/patches") -Filter *.patch | ForEach-Object {
  $dest = Join-Path $patches $_.Name
  if (-not (Test-Path $dest)) { Copy-Item $_.FullName $dest }
}

Write-Host "Baseline fetched into electron-codecs/upstream/. Ported patches go in electron-codecs/patches/."
