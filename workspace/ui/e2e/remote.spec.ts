import { expect, test } from './fixtures';

test('switching to a branch shows the commits it can pull, and pulls none of them', async ({ page, open }) => {
  const mock = await open();
  await mock.remotePush('origin/main', 3);
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('Checkout to');
  await page.keyboard.press('Enter');
  await page.locator('.pal li').filter({ hasText: /^main\s+local$/ }).click();
  await mock.idle();
  await expect(page.locator('.branch .ab')).toContainText('↓3');
  await expect(page.getByRole('button', { name: 'Pull 3 commits' })).toBeVisible();
  expect((await mock.state()).behind).toBe(3);
  const calls = await mock.calls();
  expect(calls).toContain('fetch_background');
  expect(calls).not.toContain('pull');
});

test('a branch that others push to shows their commits a few minutes later', async ({ page, open }) => {
  await page.clock.install();
  const mock = await open('clean');
  await mock.remotePush('origin/main', 2);
  await expect(page.locator('.branch .ab')).toContainText('↓0');
  await page.clock.fastForward('03:30');
  await mock.idle();
  await expect(page.locator('.branch .ab')).toContainText('↓2');
  expect((await mock.state()).behind).toBe(2);
});
