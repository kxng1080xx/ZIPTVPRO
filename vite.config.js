import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
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
        main: './index.html',
        connect: './connect.html'
      }
    }
  }
});
