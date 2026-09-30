import { expect, row, test } from './fixtures';

test('a folder with no repository opens for its terminals and says what needs git', async ({ page, open }) => {
  const mock = await open('plain');
  await expect(page.getByRole('heading', { name: 'No git repository' })).toBeVisible();
  await expect(page.locator('.no-git')).toContainText('the review, commits, branches and the Files tab need git');
  await expect(page.locator('.side-note')).toHaveText('This folder has no git repository');
  expect(await mock.calls()).not.toContain('status');
  expect(await mock.calls()).not.toContain('git_init');

  await page.getByRole('button', { name: /New Terminal/ }).click();
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
  await page.keyboard.type('echo in a plain folder');
  await page.keyboard.press('Enter');
  await mock.idle();
  expect(await mock.terminalText()).toContain('\r\nin a plain folder\r\n');
});

test('Init Repository makes the open folder a repository and opens its review', async ({ page, open }) => {
  const mock = await open('plain');
  await page.getByRole('button', { name: 'Init Repository' }).click();
  await mock.idle();
  expect(await mock.calls()).toContain('git_init');
  await expect(row(page, 'unstaged', 'src/cart.ts')).toBeVisible();
  await expect(page.locator('.no-git')).toHaveCount(0);
});
