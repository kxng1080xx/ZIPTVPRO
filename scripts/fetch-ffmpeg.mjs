// Downloads a static ffmpeg binary into ./extraResources so electron-builder can
// bundle it (see package.json build.extraResources). Idempotent: skips if already
// present. Windows is the packaged target; on mac/linux dev it skips and the
// server falls back to ffmpeg on PATH (see server/index.js findFfmpeg()).
//
// Override the source with FFMPEG_URL=... if BtbN's "latest" asset ever moves.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'extraResources');
const isWin = process.platform === 'win32';
const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const outBin = path.join(outDir, binName);

fs.mkdirSync(outDir, { recursive: true });

if (fs.existsSync(outBin)) {
  console.log(`[fetch-ffmpeg] ${binName} already present — skipping.`);
  process.exit(0);
}

if (!isWin) {
  console.log('[fetch-ffmpeg] Non-Windows dev: skipping bundle (server uses ffmpeg on PATH).');
  process.exit(0);
}

const url = process.env.FFMPEG_URL ||
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const tmpZip = path.join(os.tmpdir(), `ffmpeg-${Date.now()}.zip`);
const tmpExtract = path.join(os.tmpdir(), `ffmpeg-extract-${Date.now()}`);

console.log(`[fetch-ffmpeg] Downloading ffmpeg…\n  ${url}`);

const res = await fetch(url);
if (!res.ok) {
  console.error(`[fetch-ffmpeg] Download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(tmpZip, buf);
console.log(`[fetch-ffmpeg] Downloaded ${(buf.length / 1e6).toFixed(1)} MB. Extracting…`);

// Windows 10+ ships tar.exe (bsdtar), which extracts .zip archives.
fs.mkdirSync(tmpExtract, { recursive: true });
const r = spawnSync('tar', ['-xf', tmpZip, '-C', tmpExtract], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[fetch-ffmpeg] Extraction failed. Ensure tar is available (Windows 10+).');
  process.exit(1);
}

// Find ffmpeg.exe anywhere in the extracted tree.
function findBin(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBin(p);
      if (found) return found;
    } else if (entry.name.toLowerCase() === binName) {
      return p;
    }
  }
  return null;
}

const found = findBin(tmpExtract);
if (!found) {
  console.error('[fetch-ffmpeg] Could not locate ffmpeg.exe in the archive.');
  process.exit(1);
}

fs.copyFileSync(found, outBin);
console.log(`[fetch-ffmpeg] Installed -> ${outBin}`);

// Best-effort cleanup.
try { fs.rmSync(tmpZip, { force: true }); } catch (e) {}
try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
