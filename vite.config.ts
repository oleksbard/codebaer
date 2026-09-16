import { defineConfig } from 'vite';
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'safari16', outDir: 'dist' },
  test: { environment: 'jsdom' },
});
