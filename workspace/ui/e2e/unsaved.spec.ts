import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

async function edit(page: Page): Promise<void> {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // mine');
}

const saveDialog = (page: Page) => page.getByRole('alertdialog', { name: /save the changes you made to cart\.ts/ });

test('an edit stays unsaved until Cmd+S writes it', async ({ page, open }) => {
  const mock = await open();
  const before = (await mock.state()).files['src/cart.ts']!.work;
  await edit(page);
  await mock.idle();
  await expect(page.getByRole('button', { name: 'Close file (unsaved changes)' })).toBeVisible();
  expect(await mock.calls()).not.toContain('write_file');
  expect((await mock.state()).files['src/cart.ts']!.work).toBe(before);

  await page.keyboard.press('Meta+S');
  await mock.idle();
  expect((await mock.state()).files['src/cart.ts']!.work).toContain(' // mine');
  await expect(page.getByRole('button', { name: 'Close file', exact: true })).toBeVisible();
});

test("moving to the next file asks first, and Don't Save leaves the disk as it was", async ({ page, open }) => {
  const mock = await open();
  const before = (await mock.state()).files['src/cart.ts']!.work;
  await edit(page);
  await page.keyboard.press('Meta+Shift+]');
  await expect(saveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.tbar .file')).toContainText('cart.ts');

  await page.keyboard.press('Meta+Shift+]');
  await page.getByRole('button', { name: "Don't Save" }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).not.toContainText('cart.ts');
  expect((await mock.state()).files['src/cart.ts']!.work).toBe(before);
});

test('quitting asks about unsaved changes, and Save writes them before the app ends', async ({ page, open }) => {
  const mock = await open();
  await edit(page);
  await mock.quit();
  await expect(saveDialog(page)).toBeVisible();
  expect(await mock.exited()).toBe(false);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await mock.idle();
  expect(await mock.exited()).toBe(true);
  expect((await mock.state()).files['src/cart.ts']!.work).toContain(' // mine');
});

test('quitting with nothing unsaved ends the app without asking', async ({ page, open }) => {
  const mock = await open();
  await mock.quit();
  expect(await mock.exited()).toBe(true);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
