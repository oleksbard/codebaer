import { expect, row, test } from './fixtures';

test('accepting a hunk stages just that hunk and moves on', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Y');
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
  await page.keyboard.press('ControlOrMeta+N');
  await mock.idle();
  await expect(page.getByText('hunk 1 of 2')).toBeVisible();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.work).toContain("from './money'");
  expect(cart.work).not.toContain('discount?: number');
  expect(cart.index).toBe(cart.head);
});

test('accepting the whole file stages every hunk', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+Y');
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
  await expect(page.getByRole('img', { name: '6 files to review, 12 lines added, 12 removed' })).toBeVisible();
  await mock.agentEdit('src/new.ts', 'one\ntwo\n');
  await mock.idle();
  await expect(page.getByRole('img', { name: '7 files to review, 14 lines added, 12 removed' })).toBeVisible();
  await expect(page.locator('.diffstat .n.add')).toHaveText('+14');
});

test('the Discard all button asks first and then discards every unstaged change', async ({ page, open }) => {
  const mock = await open();
  const before = await mock.state();
  const header = page.locator('details[data-sec="unstaged"] summary');
  const discard = async () => {
    await header.locator('[data-all="menu"]').click();
    await page.locator('.queue-menu [data-all="discard"]').click();
  };
  const dialog = page.getByRole('alertdialog');

  await discard();
  await expect(dialog.getByText('Discard unstaged changes in 6 files?')).toBeVisible();
  await expect(dialog.getByText('1 untracked file is deleted and cannot be recovered.')).toBeVisible();
  await expect(dialog.getByText('src/utils/money.ts')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await mock.idle();
  expect(await mock.state()).toEqual(before);

  await discard();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await mock.idle();
  await expect(page.getByText('Nothing left to review')).toBeVisible();
  await expect(header.locator('[data-all]')).toHaveCount(0);
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  for (const f of Object.values((await mock.state()).files)) expect(f.work).toBe(f.index);
});

/** A 1 × 1 PNG, as base64: the form the mock keeps a binary file in. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('an image shows before and after, and Accept file stages it', async ({ page, open }) => {
  const mock = await open();
  await row(page, 'unstaged', 'static/logo.png').click();
  await mock.idle();
  const sides = page.locator('.img-side');
  await expect(sides.locator('figcaption')).toHaveText(['Before', 'After']);
  await expect(sides.locator('.img-meta')).toHaveText([/^160 × 120 · \d+ B$/, /^160 × 120 · \d+ B$/]);
  // a picture that decoded has a size; a broken one has none
  for (const img of await sides.locator('img').all()) {
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160);
  }

  await page.getByRole('button', { name: 'Accept file' }).click();
  await mock.idle();

  await expect(row(page, 'staged', 'static/logo.png')).toBeVisible();
  const logo = (await mock.state()).files['static/logo.png']!;
  expect(logo.index).toBe(logo.work);
  await row(page, 'staged', 'static/logo.png').click();
  await mock.idle();
  await expect(sides.locator('figcaption')).toHaveText(['Before', 'After']);
  await expect(page.locator('.image-btns')).toHaveText('Unstage file');
});

test('the Files tab shows an image from the working tree, and follows the agent', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await page.keyboard.press('ControlOrMeta+P');
  await page.keyboard.type('logo.png');
  await page.keyboard.press('Enter');
  await mock.idle();
  const side = page.locator('.img-side');
  await expect(side).toHaveCount(1);
  await expect(side.locator('.img-meta')).toHaveText(/^160 × 120 · /);
  await expect(page.getByRole('button', { name: 'View changes' })).toBeVisible();

  await mock.agentEdit('static/logo.png', PIXEL);
  await mock.idle();

  await expect(side.locator('.img-meta')).toHaveText(/^1 × 1 · \d+ B · shown at 128×$/);
});
