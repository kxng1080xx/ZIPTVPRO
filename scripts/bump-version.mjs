/**
 * Bumps the app version by 0.1 on every build and keeps all build files in sync:
 *   - package.json        -> "version" (Electron / EXE)
 *   - android/app/build.gradle -> versionName + versionCode (APK)
 *
 * The version is treated as a decimal "major.minor": 1.0 -> 1.1 -> ... -> 1.9 -> 2.0.
 * Run `npm run bump` once at the start of each build.
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- 1. package.json -------------------------------------------------------
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const isNoBump = (process.env.NO_BUMP && process.env.NO_BUMP.trim() === 'true') || process.argv.includes('--no-bump');
let newVersion;

if (isNoBump) {
  newVersion = pkg.version;
  console.log(`NO_BUMP active: Synchronizing version fields to ${newVersion} without bumping...`);
} else {
  const parts = pkg.version.split('.').map(Number);
  let newMajor = parts[0];
  let newMinor = parts[1];
  let newPatch = parts[2];

  if (process.argv.includes('--major')) {
    newMajor += 1;
    newMinor = 0;
    newPatch = 0;
  } else if (process.argv.includes('--minor')) {
    newMinor += 1;
    newPatch = 0;
  } else {
    // Default to patch bump (+0.0.1) for bug fixes
    newPatch += 1;
  }

  newVersion = `${newMajor}.${newMinor}.${newPatch}`;

  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// --- 2. android/app/build.gradle ------------------------------------------
const gradlePath = join(root, 'android', 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${newVersion}"`);
if (!isNoBump) {
  gradle = gradle.replace(/versionCode\s+(\d+)/, (_, code) => `versionCode ${Number(code) + 1}`);
}
writeFileSync(gradlePath, gradle);

console.log(`Version synchronized -> ${newVersion} (android versionName "${newVersion}")`);

