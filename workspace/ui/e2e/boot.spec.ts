import { expect, row, test } from './fixtures';

test('the review scenario opens the first change as a diff', async ({ page, open }) => {
  await open();
  await expect(row(page, 'unstaged', 'src/cart.ts')).toHaveClass(/\bsel\b/);
  await expect(page.getByText('hunk 1 of 3')).toBeVisible();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  await expect(page.getByRole('button', { name: /Acme Shop/ })).toBeVisible();
});

test('with no git the app shows only the fatal screen', async ({ page, open }) => {
  await open('no-git');
  await expect(page.locator('.fatal')).toContainText('CodeBär needs git on this machine');
});

test('a cancelled folder picker leaves an empty window', async ({ page, open }) => {
  const mock = await open('no-repo');
  expect(await mock.calls()).toContain('plugin:dialog|open');
  expect(await mock.calls()).not.toContain('open_repo');
  await expect(page.locator('.row')).toHaveCount(0);
});
