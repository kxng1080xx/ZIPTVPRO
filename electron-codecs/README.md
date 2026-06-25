# Custom Electron build with HEVC + AC3 / E-AC3 codecs (Electron 42)

Goal: build a custom Electron **42.4.0** distribution whose bundled Chromium can
decode **HEVC Main10 video + E-AC3 (Dolby Digital Plus) audio**, so premium VOD
(e.g. House of the Dragon: MKV/HEVC Main10 + E-AC3 5.1) plays in the existing
`<video>` element with all current UI/controls — no mpv, no window compositing.

> Stock Electron 42 already enables **HEVC hardware (platform) decode** but does
> **not** enable **AC3/E-AC3 audio** ([electron#48819](https://github.com/electron/electron/issues/48819)).
> This build closes that gap.

Target versions (pinned by Electron 42.4.0):

| Component | Version |
|-----------|---------|
| Electron  | **v42.4.0** |
| Chromium  | **148.0.7778.254** |
| Node.js   | **24.16.0** (match this when building) |
| V8        | 14.8.178.29 |

The published patch sets target older Electron (5rahim → v36.2.1 / ~Chromium 136,
ThaUnknown → v29.1.4). We are **porting forward to Chromium 148**, so expect the
source patches to need reconciliation. Read "Porting strategy" below first.

---

## ⚡ Try the easy path FIRST (flags only, likely enough on M148)

Because the AC3/E-AC3 gating flag (`enable_platform_ac3_eac3_audio`) and the HEVC
flags now exist **in Chromium itself**, on Chromium 148 you may NOT need the big
source patches at all — just enable the flags in your GN args and make sure
FFmpeg is built with the matching decoders/parsers. Do this before touching
`media_hevc_ac3_*.patch`.

1. Check out Electron at the exact tag and sync deps (see "Full build" below).
2. Run the StaZhu FFmpeg helper so the bundled FFmpeg includes the HEVC parser +
   AC3/E-AC3 decoders (see `fetch-baseline`), then regenerate FFmpeg config.
3. Generate the build with these GN args (`out/Release/args.gn`):

   ```gn
   import("//electron/build/args/release.gn")

   # Proprietary codecs + full FFmpeg branding (brings in AC3/E-AC3/HEVC paths)
   proprietary_codecs = true
   ffmpeg_branding = "Chrome"

   # HEVC (video) — platform/HW + parser
   enable_platform_hevc = true
   enable_hevc_parser_and_hw_decode = true

   # AC3 / E-AC3 (audio) — this is the flag electron#48819 wants on by default
   enable_platform_ac3_eac3_audio = true

   # (only if present/needed on M148)
   # enable_platform_dolby_vision = false
   ```

4. Build (`ninja -C out/Release electron`) and test with a known E-AC3 sample.
   If audio plays and HEVC renders, you are done — **skip the source patches**.

If a GN arg above is rejected as "unknown" by `gn gen`, that flag is gated behind
the source patch — fall back to "Full build with patches".

---

## Prerequisites (Windows build machine)

- Windows 10/11, **~120 GB free disk**, 16 GB+ RAM (32 GB strongly preferred).
- Visual Studio 2022 with: "Desktop development with C++", Windows 11 SDK
  (10.0.26100 or the version Chromium 148 wants), "C++ ATL", "C++ MFC", Debugging
  Tools for Windows. Match the SDK Chromium 148 expects (see DEPS).
- `DEPOT_TOOLS_WIN_TOOLCHAIN=0` system env var (use local VS, not Google's).
- Python 3, Git, and `depot_tools` on PATH.
- Node **24.16.0** (match Electron 42.4.0's DEPS) for any helper scripts.

> This compile takes **hours** and large bandwidth. It cannot run in the Cowork
> sandbox — run it on the Windows dev box (VS-Code side).

---

## Full build (with patches, if the flags-only path is not enough)

### 1. Get the baseline patches
Run the fetch script (clones the upstream patch repos + StaZhu helper into
`electron-codecs/upstream/`, which is git-ignored):

```powershell
# from repo root
pwsh electron-codecs/fetch-baseline.ps1
```
(or `bash electron-codecs/fetch-baseline.sh` on Unix)

Ported, M148-correct patches live in `electron-codecs/patches/`. Upstream
originals are in `electron-codecs/upstream/` for diffing.

### 2. Check out Electron 42.4.0
```bash
mkdir electron-src && cd electron-src
gclient config --name "src/electron" --unmanaged https://github.com/electron/electron
cd src/electron && git fetch --tags && git checkout v42.4.0 && cd ../..
gclient sync -f --with_branch_heads --with_tags
```

### 3. Enable the FFmpeg decoders/parsers (HEVC + AC3/E-AC3)
```bash
# copy StaZhu helper into the ffmpeg tree, then run it
cp electron-codecs/upstream/add-hevc-ffmpeg-decoder-parser.js src/third_party/ffmpeg/
cd src/third_party/ffmpeg && node ./add-hevc-ffmpeg-decoder-parser.js && cd -
```

### 4. Apply the (ported) source patches
```bash
cd src                       && git apply ../electron-codecs/patches/media_hevc_ac3_chromium.patch
cd electron                  && git apply ../../electron-codecs/patches/media_hevc_ac3_electron.patch && cd ..
cd third_party/ffmpeg        && git apply ../../../electron-codecs/patches/media_hevc_ac3_ffmpeg.patch && cd ../../..
```
If any patch fails, see "Porting strategy".

### 5. Configure + build
```bash
export CHROMIUM_BUILDTOOLS_PATH=`pwd`/buildtools   # PowerShell: $env:CHROMIUM_BUILDTOOLS_PATH="$(pwd)\buildtools"
gn gen out/Release --args="import(\"//electron/build/args/release.gn\") proprietary_codecs=true ffmpeg_branding=\"Chrome\" enable_platform_hevc=true enable_hevc_parser_and_hw_decode=true enable_platform_ac3_eac3_audio=true"
ninja -C out/Release electron
```

### 6. Package the dist
```bash
electron/script/strip-binaries.py -d out/Release   # Linux/mac only
ninja -C out/Release electron:electron_dist_zip
# → src/out/Release/dist.zip
```
Unzip it into `electron-codecs/dist/` (git-ignored). That folder is what
electron-builder will package instead of the stock Electron.

---

## Porting strategy (Chromium 136 → 148)

The 5rahim patches were cut against ~Chromium 136. On 148, expect `.rej` files.
For each rejected hunk, open the target file in the M148 tree, locate the
equivalent code, and re-apply by hand, then regenerate the patch with
`git diff > ...patch`. The codec gating lives mainly in:

- `src/media/media_options.gni` — the `enable_platform_ac3_eac3_audio` /
  `enable_platform_hevc` GN declarations (may already exist on M148 → just set
  them in args).
- `src/media/base/supported_types.cc` — `IsSupportedAudioType` / video type
  allow-lists (where E-AC3 / HEVC10 get accepted or rejected).
- `src/media/base/mime_util_internal.cc` — codec string → codec mapping
  (`ec-3`, `ac-3`, `hvc1`, `hev1`).
- `src/media/ffmpeg/ffmpeg_common.cc` — FFmpeg codec ID ↔ Chromium codec mapping.
- `src/media/filters/ffmpeg_demuxer.cc` / `ffmpeg_audio_decoder.cc` — demux +
  decode path enablement.
- `src/third_party/ffmpeg/` — config (`add-hevc-ffmpeg-decoder-parser.js` output)
  to compile in the `hevc` parser and `ac3`/`eac3` decoders.

Tip: before manually porting, `grep -rn "enable_platform_ac3_eac3_audio"` in the
M148 `src/` tree. If it already exists, the chromium/electron source patches are
largely redundant and the flags-only path applies.

---

## After the build: package the EXE with the custom Electron

`package.json` has a `electron:dist:codecs` script that points electron-builder at
`electron-codecs/dist/` via `--config.electronDist`. Steps:

```powershell
# 1. put the unzipped custom build in electron-codecs/dist/
# 2. then:
npm run electron:dist:codecs
```

This produces the NSIS installer using the codec-enabled Electron. The normal
`npm run electron:dist` still uses stock Electron (no codecs) for quick iteration.

### Verify codecs in the running app
Open DevTools console in the packaged app:
```js
const v = document.createElement('video');
v.canPlayType('audio/mp4; codecs="ec-3"');   // E-AC3  → "probably"/"maybe" = OK
v.canPlayType('video/mp4; codecs="hvc1.2.4.L120.90"'); // HEVC Main10
```
Empty string = not supported (build/flags didn't take).
`chrome://gpu` → "Video Acceleration Information" should list "Decode hevc main 10".

---

## Notes / caveats
- HEVC decode still rides the **GPU hardware decoder** (+ Windows "HEVC Video
  Extensions"). Very old GPUs without Main10 HW decode will still fail video even
  with this build — that's a hardware limit, not a build one. (mpv/software-decode
  remains the only universal fallback if you ever need it.)
- You must **re-do this build on every Electron upgrade**. Pin Electron in
  `package.json` and only bump deliberately.
- Keep `asar: false` (already set) — unrelated to codecs but required by the
  in-process ESM server.
