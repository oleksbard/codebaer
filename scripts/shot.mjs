// Screenshots browser mode: starts Vite on a free port, opens mock.html, waits for the fake backend to go
// idle, and saves a PNG.
//   pnpm shot [scenario] [--theme id] [--out file] [--browser chromium] [--do press:Meta+Shift+T --do click:text=Pull]
// Each --do step runs in order and waits for the backend to go idle again.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string' },
    out: { type: 'string' },
    browser: { type: 'string', default: 'webkit' },
    size: { type: 'string', default: '1280x820' },
    do: { type: 'string', multiple: true, default: [] },
  },
});
const scenario = positionals[0] ?? 'review';
const out = values.out ?? `test-results/shots/${scenario}${values.theme ? `-${values.theme}` : ''}.png`;
const [width, height] = values.size.split('x').map(Number);

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error', clearScreen: false });
await server.listen();
const browser = await (values.browser === 'chromium' ? chromium : webkit).launch();
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const settle = async () => {
    await page.evaluate(() => globalThis.__mock?.idle());
    // CodeMirror loads a language and xterm paints on the next frames, neither of which the backend sees
    await page.waitForTimeout(250);
  };
  const query = new URLSearchParams({ scenario, slow: '0', ...(values.theme ? { theme: values.theme } : {}) });
  await page.goto(`${server.resolvedUrls.local[0]}mock.html?${query}`);
  await page.waitForSelector('html[data-mock-idle]', { state: 'attached' });
  await settle();
  for (const step of values.do) {
    const [kind, ...rest] = step.split(':');
    const arg = rest.join(':');
    if (kind === 'press') await page.keyboard.press(arg);
    else if (kind === 'click') await page.locator(arg).first().click();
    else if (kind === 'type') await page.keyboard.type(arg);
    else throw new Error(`unknown step ${step}: use press:, click: or type:`);
    await settle();
  }
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(out);
  if (errors.length) {
    console.error(`the page logged errors:\n${errors.join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.close();
}
