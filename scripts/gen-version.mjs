/**
 * Emits public/version.json from package.json so the deployed web build (and the
 * native apps, which point at the public host) can check for updates in the
 * background. Run as part of `npm run build`; Vite copies public/ into dist/.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const manifest = {
  version: pkg.version,
  apk: 'https://ziptvpro.pages.dev/app.apk',
  exe: 'https://ziptvpro.pages.dev/latest.exe'
};

mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`version.json -> ${manifest.version}`);