/**
 * Bake the TMDB read token into a build artefact (9.0).
 *
 * The packaged EXE ships `server/tmdb.js` but not `.env`, so an installed app
 * had no way to reach TMDB and every lookup 503'd — silently disabling both
 * the ABOUT panels and the trailer previews. This writes the token where the
 * packaged server can find it.
 *
 * The file is gitignored (it must never be committed) but electron-builder
 * globs the filesystem via `files: ["server/**\/*"]`, not git, so it IS
 * packaged. It deliberately contains ONLY the TMDB token — never the rest of
 * .env, which holds GH_TOKEN.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readToken() {
  if (process.env.TMDB_TOKEN) return process.env.TMDB_TOKEN.trim();
  try {
    const line = fs.readFileSync(path.join(root, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*TMDB_TOKEN\s*=/.test(l));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch (e) {}
  return '';
}

const token = readToken();
const out = path.join(root, 'server', 'tmdb-baked.json');

if (!token) {
  console.warn('[bake-tmdb] No TMDB_TOKEN found — packaged build will have no metadata.');
  try { fs.unlinkSync(out); } catch (e) {}
  process.exit(0);
}

fs.writeFileSync(out, JSON.stringify({ token }, null, 2));
console.log(`[bake-tmdb] wrote server/tmdb-baked.json (${token.length} chars)`);
