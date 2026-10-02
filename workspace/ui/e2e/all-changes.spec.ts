import { expect, row, test } from './fixtures';

test('the All changes page stacks every file and stages a hunk from it', async ({ page, open }) => {
  const mock = await open();
  await page.getByRole('button', { name: 'Changes actions' }).click();
  await page.getByRole('menuitem', { name: 'Review all changes' }).click();
  await mock.idle();
  const cart = page.locator('.fsec[data-path="src/cart.ts"]');
  await expect(page.locator('.fsec')).toHaveCount(6);
  await expect(page.locator('.fsec[data-path="static/logo.png"] .img-side img')).toHaveCount(2);

  await cart.locator('button[name="accept"]').first().click();
  await mock.idle();

  await expect(row(page, 'staged', 'src/cart.ts')).toBeVisible();
  const file = (await mock.state()).files['src/cart.ts']!;
  expect(file.index).toContain("from './utils/money'");
  expect(file.index).not.toContain('reduce((sum, i)');
  await expect(cart.locator('button[name="accept"]')).toHaveCount(2);
});

test('the hunk keys walk the page, and closing it opens the file they reached', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+A');
  await mock.idle();
  await page.keyboard.press('F7');
  await page.keyboard.press('F7');
  await page.keyboard.press('F7');
  await page.keyboard.press('F7');
  await page.keyboard.press('ControlOrMeta+Y');
  await mock.idle();

  const checkout = (await mock.state()).files['src/checkout.ts']!;
  expect(checkout.index).toBe(checkout.work);
  await expect(page.locator('.fsec[data-path="src/checkout.ts"]')).toContainText('accepted');

  await page.getByRole('button', { name: /^Close all changes/ }).click();
  await mock.idle();
  await expect(page.locator('.stack')).toHaveCount(0);
  await expect(page.locator('.tbar .file')).toHaveText('src/money.ts');
});
