import { expect, test } from './fixtures';

// xterm paints on a canvas, so what a session printed is read from the fake host's ring
test('a new terminal runs a command and shows its output', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
  await page.keyboard.type('echo hi from the test');
  await page.keyboard.press('Enter');
  await mock.idle();
  expect(await mock.terminalText()).toContain('hi from the test\r\n');
});

test('an existing agent session is replayed into the rail', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Shift+T');
  await mock.idle();
  expect(await mock.terminalText(2)).toContain('Welcome to Claude Code');
  await expect(page.locator('.term-host')).toBeVisible();
});
