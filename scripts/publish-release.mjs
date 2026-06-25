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
  const up = await fetch(
    `${uploads}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${assetName}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: buf,
    }
  );
  if (!up.ok) {
    throw new Error(`Upload failed -> ${up.status} ${await up.text()}`);
  }
  console.log(`Uploaded ${assetName} successfully.`);
}

await uploadAsset(exePath, EXE_ASSET_NAME);
await uploadAsset(apkPath, APK_ASSET_NAME);

console.log(`Done. Releases available at:`);
console.log(`  - https://github.com/${OWNER}/${REPO}/releases/latest/download/${EXE_ASSET_NAME}`);
console.log(`  - https://github.com/${OWNER}/${REPO}/releases/latest/download/${APK_ASSET_NAME}`);
