import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import legacy from '@vitejs/plugin-legacy';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Legacy build (LEGACY=true): ES5 + core-js polyfills for the old Fire OS 5
// WebView (Chromium ~40). Emits ES5-only chunks (no modern/nomodule split) into
// dist-legacy so the main build is untouched. See docs/LEGACY_FIRETV.md.
const IS_LEGACY = process.env.LEGACY === 'true';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // TV-only build (tv.apk): boots straight into the native TV shell, no
    // mobile/desktop UI and no way to switch out. Set TV_ONLY=true at build.
    __TV_ONLY__: JSON.stringify(process.env.TV_ONLY === 'true'),
    // Legacy build (legacy.apk, Fire OS 5): forces performance mode on and skips
    // the local-server probe (a bare WebView wrapper never has one). Set by
    // LEGACY=true at build time.
    __LEGACY__: JSON.stringify(process.env.LEGACY === 'true')
  },
  server: {
    port: 5673,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
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
