import { expect, test } from './fixtures';

test('the palette opens a repository through the folder picker', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('Open Repository');
  await page.keyboard.press('Enter');
  await mock.idle();
  const calls = await mock.calls();
  expect(calls.slice(calls.lastIndexOf('plugin:dialog|open'))).toContain('open_repo');
});

test('⌘, opens Settings, as the native menu item does', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('Meta+Comma');
  await mock.idle();
  await expect(page.getByLabel('Sections')).toBeVisible();
});
