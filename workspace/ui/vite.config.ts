import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'safari16', outDir: 'dist' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Playwright's; its default include would take e2e/*.spec.ts too
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Vitest blanks every CSS import it does not process, `?raw` included; theme.test.ts and motion.test.ts
    // read these. No component imports a stylesheet as a module (styles.css only reaches index.html
    // through a <link>), so widening this to the whole tree costs nothing.
    css: { include: [/\/src\/.*\.css/] },
  },
});
