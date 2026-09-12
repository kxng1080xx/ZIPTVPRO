import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import legacy from '@vitejs/plugin-legacy';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Legacy build (LEGACY=true): ES5 + core-js polyfills for the old Fire OS 5
// WebView (Chromium ~40). Emits ES5-only chunks (no modern/nomodule split) into
// dist-legacy so the main build is untouched. See docs/LEGACY_FIRETV.md.
const IS_LEGACY = process.env.LEGACY === 'true';

// TMDB read token baked into CLIENT-MODE builds (APK / Fire TV / hosted web).
// Those have no bundled Node server, so /api/meta does not exist for them and
// every metadata lookup would 404 — silently killing the ABOUT panels and the
// trailer previews on exactly the 10-foot devices this release targets. The
// desktop build does NOT rely on this: it proxies through its local server
// (server/tmdb.js), which keeps the token server-side.
function tmdbToken() {
  if (process.env.TMDB_TOKEN) return process.env.TMDB_TOKEN.trim();
  try {
    const lines = readFileSync('./.env', 'utf8').split(/\r?\n/);
    const line = lines.find((l) => /^\s*TMDB_TOKEN\s*=/.test(l));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch (e) {}
  return '';
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // TV-only build (tv.apk): boots straight into the native TV shell, no
    // mobile/desktop UI and no way to switch out. Set TV_ONLY=true at build.
    __TV_ONLY__: JSON.stringify(process.env.TV_ONLY === 'true'),
    // Legacy build (legacy.apk, Fire OS 5): forces performance mode on and skips
    // the local-server probe (a bare WebView wrapper never has one). Set by
    // LEGACY=true at build time.
    __LEGACY__: JSON.stringify(process.env.LEGACY === 'true'),
    // See tmdbToken() above. Empty string in a build with no token available,
    // which the client treats as "no metadata" rather than failing.
    __TMDB_TOKEN__: JSON.stringify(tmdbToken())
  },
  server: {
    port: 5673,
    proxy: {
      '/api': {
        // Port 3000 is frequently taken by another local project, and the API
        // server then can't bind at all. API_PORT lets dev run on a free port
        // without editing this file or killing whatever owns 3000.
        target: `http://localhost:${process.env.API_PORT || 3000}`,
        changeOrigin: true
      }
    }
  },
  plugins: IS_LEGACY ? [legacy({
    targets: ['chrome >= 40', 'android >= 5'],
    renderModernChunks: false, // ES5-only output (old WebView has no ES modules)
    polyfills: true,
    modernPolyfills: false
  })] : [],
  build: {
    // Transpile down to ~Chromium 70-era syntax: old system WebViews (Fire TV
    // sticks) can't PARSE newer syntax and white-screen on the whole bundle.
    // Missing runtime APIs are shimmed separately in src/compat.js. The LEGACY
    // build goes further (full ES5 via plugin-legacy) for Fire OS 5.
    target: IS_LEGACY ? 'es2015' : 'es2018',
    outDir: IS_LEGACY ? 'dist-legacy' : 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        connect: resolve(__dirname, 'connect.html')
      }
    }
  }
});
