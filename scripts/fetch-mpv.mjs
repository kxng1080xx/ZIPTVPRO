// Downloads a portable mpv.exe into ./extraResources so electron-builder can
// bundle it (see package.json build.extraResources "mpv*" filter). OPTIONAL:
// the app also finds mpv on PATH or in common install dirs at runtime and works
// fine without a bundled copy, so this is a convenience for shipping a
// self-contained installer — it is NOT wired into electron:dist by default
// (mpv adds ~50 MB).
//
// Idempotent: skips if mpv.exe is already present. Windows-only (the MPV engine
// is a desktop feature). Override the source with MPV_URL=... — a .zip is
// extracted with the built-in tar; a .7z needs 7-Zip (7z.exe) on PATH.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'extraResources');
const isWin = process.platform === 'win32';
const binName = 'mpv.exe';
const outBin = path.join(outDir, binName);

fs.mkdirSync(outDir, { recursive: true });

if (fs.existsSync(outBin)) {
  console.log(`[fetch-mpv] ${binName} already present — skipping.`);
  process.exit(0);
}

if (!isWin) {
  console.log('[fetch-mpv] Non-Windows: skipping (the MPV engine is desktop/Windows-only; runtime uses mpv on PATH).');
  process.exit(0);
}

const url = process.env.MPV_URL;
if (!url) {
  console.log(
    '[fetch-mpv] No MPV_URL set — skipping bundle.\n' +
    '  The app resolves mpv from PATH / common install dirs at runtime, so this is optional.\n' +
    '  To bundle it: set MPV_URL to a Windows mpv build (.zip or .7z) and re-run,\n' +
    '  or drop mpv.exe into ./extraResources yourself.'
  );
  process.exit(0);
}

const isSevenZip = /\.7z($|\?)/i.test(url);
const tmpArchive = path.join(os.tmpdir(), `mpv-${Date.now()}${isSevenZip ? '.7z' : '.zip'}`);
const tmpExtract = path.join(os.tmpdir(), `mpv-extract-${Date.now()}`);

console.log(`[fetch-mpv] Downloading mpv…\n  ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`[fetch-mpv] Download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(tmpArchive, buf);
console.log(`[fetch-mpv] Downloaded ${(buf.length / 1e6).toFixed(1)} MB. Extracting…`);

fs.mkdirSync(tmpExtract, { recursive: true });
let r;
if (isSevenZip) {
  // .7z needs 7-Zip. Try 7z.exe on PATH; guide the user if it's missing.
  r = spawnSync('7z', ['x', '-y', `-o${tmpExtract}`, tmpArchive], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error('[fetch-mpv] .7z extraction failed. Install 7-Zip (7z.exe on PATH) or point MPV_URL at a .zip build.');
    process.exit(1);
  }
} else {
  // Windows 10+ ships tar.exe (bsdtar), which extracts .zip archives.
  r = spawnSync('tar', ['-xf', tmpArchive, '-C', tmpExtract], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[fetch-mpv] Extraction failed. Ensure tar is available (Windows 10+) or use a .7z with 7-Zip installed.');
    process.exit(1);
  }
}

// Find mpv.exe anywhere in the extracted tree.
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
  console.error('[fetch-mpv] Could not locate mpv.exe in the archive.');
  process.exit(1);
}

fs.copyFileSync(found, outBin);
console.log(`[fetch-mpv] Installed -> ${outBin}`);

// Best-effort cleanup.
try { fs.rmSync(tmpArchive, { force: true }); } catch (e) {}
try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
