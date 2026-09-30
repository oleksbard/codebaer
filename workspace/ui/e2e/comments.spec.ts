import { expect, test } from './fixtures';

const LINE = 'const net = i.price - i.discount;';

test('a comment on a selected line is sent to the agent session as one quoted block', async ({ page, open }) => {
  const mock = await open('video');
  await page.locator('.side .row', { hasText: 'cart.ts' }).click();
  await mock.idle();
  await page.locator('.cm-line', { hasText: LINE }).first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < LINE.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.locator('.comment-chip').click();
  await page.keyboard.type('Clamp this at zero.');
  await page.getByRole('button', { name: /^Send/ }).click();
  await page.locator('.pal li', { hasText: 'claude:1' }).click();
  await expect(page.getByText('Sent 1 comment to claude:1')).toBeVisible();
  const text = await mock.terminalText(1);
  expect(text).toContain('src/cart.ts:10\r\n');
  expect(text).toContain('+    const net = i.price - i.discount;');
  expect(text.endsWith('Clamp this at zero.\r\n\r\n')).toBe(true);
  expect(text).not.toContain('It heard');
  await expect(page.locator('.term-host')).toBeVisible();
});

test('what an agent session is told to print shows in its terminal', async ({ page, open }) => {
  const mock = await open('video');
  await page.locator('.rail .rail-b', { hasText: 'claude:1' }).click();
  await mock.terminalWrite('Done. Nothing else to change.\n', 1);
  await expect(page.locator('.term-host .xterm-rows > div').filter({ hasText: 'Nothing else to change' }))
    .toHaveCount(1);
});
