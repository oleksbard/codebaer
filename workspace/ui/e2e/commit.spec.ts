import { expect, row, test } from './fixtures';

test('the AI message fills the box, and committing clears what was staged', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Shift+Y');
  await mock.idle();
  await page.getByRole('button', { name: 'Write the commit message with Claude' }).click();
  await mock.idle();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue(/^Update cart\.ts and 1 more/);
  await page.locator('#commit-btn').click();
  await mock.idle();
  await expect(page.getByText('Committed')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  await expect(row(page, 'staged', 'src/cart.ts')).toHaveCount(0);
  await expect(page.locator('.branch .ab')).toContainText('↑2');
  const s = await mock.state();
  expect(s.files['src/cart.ts']!.head).toBe(s.files['src/cart.ts']!.work);
});

test('a rejected push shows why', async ({ page, open }) => {
  const mock = await open();
  await mock.fail('push', { kind: 'Git', detail: 'rejected: non-fast-forward' });
  await page.getByRole('button', { name: 'Push 1 commit' }).click();
  await mock.idle();
  await expect(page.getByText('rejected: non-fast-forward')).toBeVisible();
});
