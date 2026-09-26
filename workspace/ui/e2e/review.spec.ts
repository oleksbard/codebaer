import { expect, row, test } from './fixtures';

test('accepting a hunk stages just that hunk and moves on', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Y');
  await mock.idle();
  await expect(page.getByText('hunk 1 of 2')).toBeVisible();
  await expect(row(page, 'staged', 'src/cart.ts')).toBeVisible();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.index).toContain("from './utils/money'");
  expect(cart.index).not.toContain('reduce((sum, i)');
  expect(cart.work).toContain('reduce((sum, i)');
});

test('rejecting a hunk reverts it in the working tree', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+N');
  await mock.idle();
  await expect(page.getByText('hunk 1 of 2')).toBeVisible();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.work).toContain("from './money'");
  expect(cart.work).not.toContain('discount?: number');
  expect(cart.index).toBe(cart.head);
});

test('accepting the whole file stages every hunk', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Shift+Y');
  await mock.idle();
  await expect(row(page, 'unstaged', 'src/cart.ts')).toHaveCount(0);
  await expect(row(page, 'staged', 'src/cart.ts')).toBeVisible();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.index).toBe(cart.work);
});

test('with no file open the view counts the lines left to review and follows the agent', async ({ page, open }) => {
  const mock = await open();
  await page.getByRole('button', { name: 'Close file' }).click();
  await mock.idle();
  await expect(page.getByRole('img', { name: '12 lines added, 12 removed' })).toBeVisible();
  await mock.agentEdit('src/new.ts', 'one\ntwo\n');
  await mock.idle();
  await expect(page.getByRole('img', { name: '14 lines added, 12 removed' })).toBeVisible();
  await expect(page.locator('.diffstat .n.add')).toHaveText('+14');
});
