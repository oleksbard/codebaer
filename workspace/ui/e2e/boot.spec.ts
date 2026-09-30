import { expect, row, test } from './fixtures';

test('the review scenario opens the first change as a diff', async ({ page, open }) => {
  await open();
  await expect(row(page, 'unstaged', 'src/cart.ts')).toHaveClass(/\bsel\b/);
  await expect(page.getByText('hunk 1 of 3')).toBeVisible();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  await expect(page.getByRole('button', { name: /Acme Shop/ })).toBeVisible();
});

test('with no git the app opens the folder for its terminals and says to install git', async ({ page, open }) => {
  const mock = await open('no-git');
  await expect(page.getByRole('heading', { name: 'git is not installed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Init Repository' })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
});

test('a cancelled folder picker leaves an empty window', async ({ page, open }) => {
  const mock = await open('no-repo');
  expect(await mock.calls()).toContain('plugin:dialog|open');
  expect(await mock.calls()).not.toContain('open_repo');
  await expect(page.locator('.row')).toHaveCount(0);
  // a first launch has no repo to offer again, only a folder to pick
  await expect(page.getByRole('heading', { name: 'No repository open' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open Folder/ })).toBeVisible();
  await expect(page.locator('.no-repo-card')).toHaveCount(0);
});
