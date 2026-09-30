import { expect, test } from './fixtures';

test('Check for Updates finds a release, and Restart to Update installs it', async ({ page, open }) => {
  const mock = await open('update');
  await page.getByRole('button', { name: 'CodeBär menu' }).click();
  await page.getByRole('menuitem', { name: 'Check for Updates…' }).click();
  await mock.idle();
  await expect(page.getByText('CodeBär 0.6.0 is out. Install it from the button in the header.')).toBeVisible();

  await page.getByRole('button', { name: 'Update to 0.6.0' }).click();
  await page.getByRole('menuitem', { name: 'Restart to Update' }).click();
  await mock.idle();
  expect(await mock.calls()).toContain('update_install');
  expect(await mock.exited()).toBe(true);
});

test('the native menu item checks as well', async ({ page, open }) => {
  const mock = await open('update');
  await mock.menu('check-updates');
  await mock.idle();
  await expect(page.getByRole('button', { name: 'Update to 0.6.0' })).toBeVisible();
});

test('a build that does not update itself offers no check', async ({ page, open }) => {
  await open();
  await page.getByRole('button', { name: 'CodeBär menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Terminals and Orphans…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Check for Updates…' })).toHaveCount(0);
});

test('hovering the pill tints only the pill, not the header grid cell it sits in', async ({ page, open }) => {
  const mock = await open('update');
  await page.getByRole('button', { name: 'CodeBär menu' }).click();
  await page.getByRole('menuitem', { name: 'Check for Updates…' }).click();
  await mock.idle();
  const btn = page.locator('button.update-pill');
  await btn.waitFor();
  await btn.hover();
  const bg = await page.evaluate(() => ({
    wrapper: getComputedStyle(document.querySelector('.head .update-slot')!).backgroundColor,
    button: getComputedStyle(document.querySelector('button.update-pill')!).backgroundColor,
  }));
  expect(bg.wrapper).toBe('rgba(0, 0, 0, 0)');
  expect(bg.button).not.toBe('rgba(0, 0, 0, 0)');
});
