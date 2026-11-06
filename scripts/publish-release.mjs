/**
 * Publishes the Windows installer to a GitHub Release so that
 *   https://github.com/kxng1080xx/ZIPTVPRO/releases/latest/download/latest.exe
 * (the redirect target in vercel.json -> ziptvpro-nu.vercel.app/latest.exe) resolves.
 *
 * The release asset MUST be named exactly `latest.exe` for the redirect to work.
 *
 * Usage:  GH_TOKEN=<token> npm run release
 *   - Reads the version from package.json and tags the release `v<version>`.
 *   - Creates the release if it doesn't exist, otherwise reuses it.
 *   - Replaces any existing `latest.exe` asset on that release.
 *
 * The token needs `contents:write` (classic PAT: `repo` scope) on the target repo.
 */
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'fs';
import { request } from 'https';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OWNER = 'kxng1080xx';
const REPO = 'ZIPTVPRO';
const EXE_ASSET_NAME = 'latest.exe';
const APK_ASSET_NAME = 'app.apk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load a gitignored .env (KEY=value lines) so the token never has to be typed.
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('ERROR: set GH_TOKEN (or GITHUB_TOKEN) to a GitHub PAT with repo/contents:write scope.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const exePath = join(root, EXE_ASSET_NAME);
const apkPath = join(root, APK_ASSET_NAME);

// Verify version alignment between package.json and android/app/build.gradle
const gradlePath = join(root, 'android', 'app', 'build.gradle');
const gradle = readFileSync(gradlePath, 'utf8');
const match = gradle.match(/versionName\s+"([^"]*)"/);
if (!match) {
  console.error('ERROR: Could not find versionName in android/app/build.gradle');
  process.exit(1);
}
const gradleVersion = match[1];
if (gradleVersion !== version) {
  console.error(`ERROR: Version mismatch! package.json has ${version} but android/app/build.gradle has ${gradleVersion}.`);
  process.exit(1);
}
console.log(`Version alignment verified: ${version}`);

try { statSync(exePath); } catch {
  console.error(`ERROR: ${EXE_ASSET_NAME} not found. Run "npm run electron:dist" first.`);
  process.exit(1);
}

try { statSync(apkPath); } catch {
  console.error(`ERROR: ${APK_ASSET_NAME} not found. Run "npm run apk" first.`);
  process.exit(1);
}

const api = 'https://api.github.com';
const uploads = 'https://uploads.github.com';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function gh(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${opts.method || 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

// 1. Find or create the release for this tag.
let release;
{
  const res = await gh(`${api}/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  if (res.status === 404) {
    console.log(`Creating release ${tag}...`);
    const create = await gh(`${api}/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: `ZIPTV Pro ${version}`,
        draft: false,
        prerelease: false,
      }),
    });
    release = await create.json();
  } else {
    release = await res.json();
    console.log(`Reusing existing release ${tag} (id ${release.id}).`);
  }
}

// 2. Remove any existing assets named latest.exe or ZIPTV-Pro.apk so the new uploads stick.
for (const asset of release.assets || []) {
  if (asset.name === EXE_ASSET_NAME || asset.name === APK_ASSET_NAME) {
    console.log(`Deleting existing asset ${asset.name} (id ${asset.id})...`);
    await gh(`${api}/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE' });
  }
}

// 3. Helper to upload an asset
async function uploadAsset(filePath, assetName) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(size);
  readSync(fd, buf, 0, size, 0);
  closeSync(fd);

  console.log(`Uploading ${assetName} (${(size / 1048576).toFixed(1)} MB)...`);
  // Stream the buffer in 1 MB pulls so we can draw a progress bar. fetch pulls
  // the next chunk only as the socket drains, so "sent" tracks the real upload.
  const CHUNK = 1 << 20;
  const started = Date.now();
  let sent = 0, lastLogged = -1;
  const progress = () => {
    const pct = Math.floor((sent / size) * 100);
    const mbps = sent / 1048576 / Math.max(0.001, (Date.now() - started) / 1000);
    const eta = mbps > 0 ? Math.round((size - sent) / 1048576 / mbps) : 0;
    const bar = '#'.repeat(Math.floor(pct / 4)).padEnd(25, '-');
    const line = `  [${bar}] ${String(pct).padStart(3)}%  ${(sent / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)} MB  ${mbps.toFixed(2)} MB/s  ETA ${eta}s`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
    else if (pct >= lastLogged + 10 || sent === size) { lastLogged = pct; console.log(line); } // piped: one line per 10%
  };
  // node:https, not fetch: fetch's 300s headersTimeout runs from request start,
  // so a slow upload (151 MB at ~0.4 MB/s) died with UND_ERR_HEADERS_TIMEOUT.
  const result = await new Promise((resolve, reject) => {
    const req = request(
      `${uploads}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${assetName}`,
      // GitHub rejects requests without a User-Agent (fetch added one implicitly).
      { method: 'POST', headers: { ...headers, 'User-Agent': 'ziptv-release', 'Content-Type': 'application/octet-stream', 'Content-Length': size } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    // Write 1 MB at a time, waiting for 'drain', so "sent" follows the socket.
    const pump = () => {
      while (sent < size) {
        const chunk = buf.subarray(sent, Math.min(sent + CHUNK, size));
        sent += chunk.length;
        const more = req.write(chunk);
        progress();
        if (!more) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload failed -> ${result.status} ${result.text}`);
  }
  console.log(`Uploaded ${assetName} successfully.`);
}

await uploadAsset(exePath, EXE_ASSET_NAME);
await uploadAsset(apkPath, APK_ASSET_NAME);

console.log(`Done. Releases available at:`);
console.log(`  - https://github.com/${OWNER}/${REPO}/releases/latest/download/${EXE_ASSET_NAME}`);
console.log(`  - https://github.com/${OWNER}/${REPO}/releases/latest/download/${APK_ASSET_NAME}`);
