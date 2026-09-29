import { expect, test } from './fixtures';

test('the handle collapses the sidebar and expands it, and the choice survives a reload', async ({ page, open }) => {
  await open();
  const side = page.locator('.side');
  const left = async () => (await page.locator('.main').boundingBox())!.x;
  const openLeft = await left();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(side).toBeHidden();
  await expect.poll(left).toBeLessThan(openLeft - 200);

  await open();
  await expect(side).toBeHidden();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(side).toBeVisible();
  await expect.poll(left).toBe(openLeft);
});

test('the handle shows on Changes and Files but not on a terminal', async ({ page, open }) => {
  const mock = await open();
  const handle = page.locator('.side-handle');
  await expect(handle).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await mock.idle();
  await expect(handle).toBeVisible();
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
  await expect(handle).toHaveCount(0);
});

test('a key that focuses inside a collapsed sidebar expands it first', async ({ page, open }) => {
  const mock = await open();
  const side = page.locator('.side');
  const collapse = async () => {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(side).toBeHidden();
  };

  await collapse();
  await page.keyboard.press('ControlOrMeta+0');
  await expect(side).toBeVisible();
  await expect(page.locator('.side .list')).toBeFocused();

  await collapse();
  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeFocused();

  await collapse();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await mock.idle();
  await expect(side).toBeVisible();
  await expect(page.locator('.side .list')).toBeFocused();
});

test('the commit box stays one line tall after a launch with the sidebar collapsed', async ({ page, open }) => {
  await open();
  const box = page.getByRole('textbox', { name: 'Commit message' });
  const height = async () => (await box.boundingBox())!.height;
  const oneLine = await height();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();

  await open();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(box).toBeVisible();
  await expect.poll(height).toBe(oneLine);
});
