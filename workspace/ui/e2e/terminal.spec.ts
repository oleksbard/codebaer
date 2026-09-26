import { expect, test } from './fixtures';

test('a new terminal runs a command and shows its output', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
  await page.keyboard.type('echo hi from the test');
  await page.keyboard.press('Enter');
  await mock.idle();
  // the typed command is echoed first, so only a line of its own tells the output apart
  expect(await mock.terminalText()).toContain('\r\nhi from the test\r\n');
  await expect(page.locator('.term-host .xterm-rows > div').filter({ hasText: /^hi from the test\s*$/ }))
    .toHaveCount(1);
});

test('closing a terminal removes it from the rail', async ({ page, open }) => {
  const mock = await open();
  const sessions = page.locator('.rail .rail-b:not(.new)');
  await page.keyboard.press('Meta+T');
  await mock.idle();
  // the review scenario starts with a shell and an agent session
  await expect(sessions).toHaveCount(3);
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('Terminal: Close Session');
  await page.keyboard.press('Enter');
  await mock.idle();
  await expect(sessions).toHaveCount(2);
});

test('an existing agent session is replayed into the rail', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Shift+T');
  await mock.idle();
  expect(await mock.terminalText(2)).toContain('Welcome to Claude Code');
  await expect(page.locator('.term-host')).toBeVisible();
});
