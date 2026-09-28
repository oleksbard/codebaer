import { expect, test } from './fixtures';

test('the palette opens a repository through the folder picker', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.type('Open Repository');
  await page.keyboard.press('Enter');
  await mock.idle();
  const calls = await mock.calls();
  expect(calls.slice(calls.lastIndexOf('plugin:dialog|open'))).toContain('open_repo');
});

test('Mod+, opens Settings, as the native menu item does on macOS', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Comma');
  await mock.idle();
  await expect(page.getByLabel('Sections')).toBeVisible();
});
