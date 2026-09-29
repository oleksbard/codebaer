import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const toggle = (page: Page) => page.getByRole('button', { name: 'Side by side' });
const top = async (page: Page, side: 'a' | 'b', text: string): Promise<number> =>
  (await page.locator(`.cm-merge-${side} .cm-line`, { hasText: text }).first().boundingBox())!.y;

test('side by side lines the index up with the working tree, and a hunk button stages it', async ({ page, open }) => {
  const mock = await open();
  await toggle(page).click();
  await mock.idle();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.editor-host > .cm-editor')).toHaveCount(2);
  await expect(page.locator('.cm-merge-a .cm-changedLine', { hasText: 'let total = 0;' })).toBeVisible();
  await expect(page.locator('.cm-merge-b .cm-deletedLine').first()).toBeHidden();

  // after a chunk the right side wraps longer, and after one that takes out more lines than it adds
  for (const line of ['export type Cart', 'export function itemCount']) {
    await expect.poll(async () => Math.abs(await top(page, 'a', line) - await top(page, 'b', line))).toBeLessThan(1);
  }

  await page.locator('.cm-merge-b .cm-chunkButtons button[name=accept]').first().click();
  await mock.idle();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.index).toContain("from './utils/money'");
  expect(cart.index).not.toContain('reduce((sum, i)');
  await expect(page.locator('.cm-merge-a .cm-line').first()).toHaveText("import { formatMoney } from './utils/money';");
});

test('a click on a deleted line on the left is where the hunk keys act', async ({ page, open }) => {
  const mock = await open();
  await toggle(page).click();
  await mock.idle();
  await page.locator('.cm-merge-a .cm-line', { hasText: 'let total = 0;' }).click();
  await expect(page.getByText('hunk 2 of 3')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Y');
  await mock.idle();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.index).toContain('reduce((sum, i)');
  expect(cart.index).not.toContain("from './utils/money'");
});

test('the All changes page switches every file, and back', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+A');
  await mock.idle();
  await toggle(page).click();
  await mock.idle();
  const cart = page.locator('.fsec[data-path="src/cart.ts"] .fbody');
  await expect(cart.locator(':scope > .cm-editor')).toHaveCount(2);
  await expect(cart.locator('.cm-merge-a .cm-changedLine', { hasText: 'let total = 0;' })).toBeVisible();

  await toggle(page).click();
  await mock.idle();
  await expect(cart.locator(':scope > .cm-editor')).toHaveCount(1);
  await expect(cart.locator('.cm-deletedLine', { hasText: 'let total = 0;' })).toBeVisible();
});
