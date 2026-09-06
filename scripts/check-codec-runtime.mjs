/**
 * Preflight for `npm run electron:dist` — the SHIPPING desktop build, which runs
 * on the codec-patched Electron in electron-codecs/dist (HEVC + AC3/E-AC3 in
 * <video>; stock Electron has no AC3/E-AC3 — electron#48819).
 *
 * That runtime is a ~226 MB unsigned binary and is gitignored, so a fresh clone
 * has no copy of it. Without this check electron-builder fails deep in its own
 * plumbing and the obvious "fix" is to fall back to the stock build — which
 * silently ships an EXE with no premium codecs. Fail loudly instead.
 *
 * See electron-codecs/README.md for the re-extraction recipe.
 */
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'electron-codecs', 'dist');
const EXPECTED = '42.2.0'; // must match --config.electronVersion in electron:dist

function die(msg) {
  console.error('\n  Codec runtime check FAILED\n');
  console.error('  ' + msg + '\n');
  console.error('  Expected a codec-patched Electron ' + EXPECTED + ' at:');
  console.error('    ' + dist + '\n');
  console.error('  Recipe: electron-codecs/README.md');
  console.error('  To build without premium codecs on purpose: npm run electron:dist:stock\n');
  process.exit(1);
}

if (!existsSync(join(dist, 'electron.exe'))) die('electron-codecs/dist/electron.exe is missing.');

const versionFile = join(dist, 'version');
if (!existsSync(versionFile)) die('electron-codecs/dist/version is missing.');
const version = readFileSync(versionFile, 'utf8').trim().replace(/^v/, '');
if (version !== EXPECTED) {
  die(`Runtime is Electron ${version}, but electron:dist pins ${EXPECTED}. Update both together.`);
}

// The patched ffmpeg.dll is ~4.6 MB; stock is ~2.7 MB. A stock-sized DLL here
// means the dist got overwritten with an unpatched runtime and the EXE would
// build fine while playing no AC3/E-AC3 at all.
const dll = join(dist, 'ffmpeg.dll');
if (!existsSync(dll)) die('electron-codecs/dist/ffmpeg.dll is missing.');
const mb = statSizeMb(dll);
if (mb < 3.5) die(`ffmpeg.dll is ${mb.toFixed(1)} MB — that is the STOCK build. The patched one is ~4.6 MB.`);

function statSizeMb(p) {
  return readFileSync(p).length / (1024 * 1024);
}

console.log(`Codec runtime OK: Electron ${version}, ffmpeg.dll ${mb.toFixed(1)} MB (HEVC + AC3/E-AC3).`);
