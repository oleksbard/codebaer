import { expect, test } from './fixtures';

test('the search key opens the tab with the query focused; a hit opens its file at the match', async ({
  page, open,
}) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Search', exact: true })).toBeFocused();

  await page.keyboard.type('subtotal');
  await expect(page.locator('.side [role=status]')).toHaveText(/results? in 2 files/);
  await expect(page.locator('.side .sfile')).toHaveText([/cart\.ts/, /checkout\.ts/]);

  await page.locator('.side .row.hit', { hasText: 'return subtotal(cart) + tax(cart);' }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).toHaveText(/checkout\.ts/);
  await expect(page.locator('.side .row.hit.sel')).toHaveText('return subtotal(cart) + tax(cart);');
  // the list keeps focus, so the editor draws the selection itself rather than through the DOM's
  await expect(page.locator('.cm-selectionBackground')).toHaveCount(1);
  await expect(page.locator('.cm-content .cm-searchMatch').first()).toHaveText('subtotal');

  // the arrows walk the hits from the list
  await page.locator('.side .list').focus();
  await page.keyboard.press('ArrowUp');
  await mock.idle();
  await expect(page.locator('.side .row.hit.sel')).toHaveText('return subtotal(cart) * TAX_RATE;');
});

test('the folder field narrows the search, and the list follows an agent\'s edit while it shows', async ({
  page, open,
}) => {
  const mock = await open();
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('formatMoney');
  await expect(page.locator('.side .sfile')).not.toHaveCount(0);
  await page.getByLabel('Folders to search').fill('src/utils');
  await expect(page.locator('.side .sfile')).toHaveText([/money\.ts/]);

  await mock.agentEdit('src/utils/format.ts', 'export { formatMoney } from \'./money\';\n');
  await expect(page.locator('.side .sfile')).toHaveText([/format\.ts/, /money\.ts/]);
});

test('a search with more hits than the cap says so and still draws only the rows in view', async ({ page, open }) => {
  await open('big');
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await page.keyboard.type('shared');
  await expect(page.locator('.side').getByText('Only the first 20,000 are listed')).toBeVisible();
  await expect(page.locator('.side [role=status]')).toHaveText(/^20000 results/);
  expect(await page.locator('.side .row, .side .sec').count()).toBeLessThan(120);
});
