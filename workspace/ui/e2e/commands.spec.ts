import { expect, test } from './fixtures';

test('the command menu draws an icon the AI picked for each command, and asks only once', async ({ page, open }) => {
  const mock = await open();
  await page.locator('.task-b').click();
  await mock.idle();
  const item = (name: string) => page.locator('.task-menu .menu-item').filter({ hasText: name });
  // browser mode's stand-in AI names an icon by a word of the command; the 24-unit grid is the icon sets'
  for (const name of ['Type check', 'build', 'test']) {
    await expect(item(name).locator('.cicon svg[viewBox="0 0 24 24"]'), name).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.locator('.task-b').click();
  await mock.idle();
  expect((await mock.calls()).filter((c) => c === 'ai_command_icons')).toHaveLength(1);
});
