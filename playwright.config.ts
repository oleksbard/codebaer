import { defineConfig } from '@playwright/test';

// not 1420, which `pnpm tauri dev` holds, so both can run at once
const PORT = 1430;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  // every page gets its own in-memory backend, so tests share nothing
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // the window size in tauri.conf.json, at Retina scale
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // the app runs in WKWebView, so WebKit is the engine that counts
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/mock.html`,
    reuseExistingServer: !CI,
  },
});
