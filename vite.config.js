import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // TV-only build (tv.apk): boots straight into the native TV shell, no
    // mobile/desktop UI and no way to switch out. Set TV_ONLY=true at build.
    __TV_ONLY__: JSON.stringify(process.env.TV_ONLY === 'true')
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
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        connect: resolve(__dirname, 'connect.html')
      }
    }
  }
});
