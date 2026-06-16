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

const [major, minor] = pkg.version.split('.').map(Number);
const bumped = Math.round((Number(`${major}.${minor}`) + 0.1) * 10) / 10; // 1.0 -> 1.1, 1.9 -> 2.0
const [newMajor, newMinor] = bumped.toFixed(1).split('.').map(Number);
const newVersion = `${newMajor}.${newMinor}.0`;

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// --- 2. android/app/build.gradle ------------------------------------------
const gradlePath = join(root, 'android', 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${newMajor}.${newMinor}"`);
gradle = gradle.replace(/versionCode\s+(\d+)/, (_, code) => `versionCode ${Number(code) + 1}`);
writeFileSync(gradlePath, gradle);

console.log(`Version bumped -> ${newVersion} (android versionName "${newMajor}.${newMinor}")`);
