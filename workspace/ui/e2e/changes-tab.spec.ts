import { expect, row, test } from './fixtures';

test('coming back to Changes from a file in Files opens the first file left to review', async ({ page, open }) => {
  const mock = await open();
  await row(page, 'unstaged', 'src/checkout.ts').click();
  await mock.idle();
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  await page.locator('.row.f', { hasText: 'README.md' }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).toHaveText(/README\.md/);

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await mock.idle();
  await expect(row(page, 'unstaged', 'src/cart.ts')).toHaveClass(/\bsel\b/);
  await expect(page.locator('.tbar .file')).toHaveText(/cart\.ts/);
  await expect(page.getByText('hunk 1 of 3')).toBeVisible();
});

test('a file from the queue stays open across a visit to a terminal', async ({ page, open }) => {
  const mock = await open();
  await row(page, 'unstaged', 'src/checkout.ts').click();
  await mock.idle();
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await mock.idle();
  await expect(row(page, 'unstaged', 'src/checkout.ts')).toHaveClass(/\bsel\b/);
  await expect(page.locator('.tbar .file')).toHaveText(/checkout\.ts/);
});

test('with nothing to review, coming back to Changes says so instead of keeping the file', async ({ page, open }) => {
  const mock = await open('clean');
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  await page.locator('.row.f', { hasText: 'README.md' }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).toHaveText(/README\.md/);

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await mock.idle();
  await expect(page.getByRole('heading', { name: 'Nothing left to review' })).toBeVisible();
});

test('unsaved edits to a file from Files are asked about first, and Cancel stays in Files', async ({ page, open }) => {
  const mock = await open();
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  await page.locator('.row.f', { hasText: 'README.md' }).click();
  await mock.idle();
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('mine ');

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(page.getByRole('alertdialog', { name: /save the changes you made to README\.md/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tbar .file')).toHaveText(/README\.md/);

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await page.getByRole('button', { name: "Don't Save" }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).toHaveText(/cart\.ts/);
});
