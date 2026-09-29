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

test('a script hidden in Settings leaves the command menu, stays hidden, and comes back', async ({ page, open }) => {
  const mock = await open();
  const menuItem = (name: string) => page.locator('.task-menu .menu-item').filter({ hasText: name });
  const openMenu = async () => {
    await page.locator('.task-b').click();
    await mock.idle();
  };
  const manage = async () => {
    await openMenu();
    await menuItem('Manage commands').click();
    await mock.idle();
  };
  await openMenu();
  await expect(menuItem('dev')).toBeVisible();
  await page.keyboard.press('Escape');

  await manage();
  await page.getByRole('button', { name: 'Hide dev' }).click();
  await mock.idle();
  await expect(page.locator('.cmd-scripts .cmd-row.off')).toHaveText(/dev/);
  await page.keyboard.press('Escape');
  await openMenu();
  await expect(menuItem('build')).toBeVisible();
  await expect(menuItem('dev')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await manage();
  await page.getByRole('button', { name: 'Show dev' }).click();
  await mock.idle();
  await page.keyboard.press('Escape');
  await openMenu();
  await expect(menuItem('dev')).toBeVisible();
});

test('a command menu taller than the window scrolls, with Manage commands kept in view', async ({ page, open }) => {
  await page.setViewportSize({ width: 1000, height: 220 });
  const mock = await open();
  await page.locator('.task-b').click();
  await mock.idle();
  const menu = page.locator('.task-menu');
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(220);
  await expect(page.getByRole('menuitem', { name: /Manage commands/ })).toBeInViewport();
  const last = page.locator('.task-menu .menu-item').filter({ hasText: 'vitest run' });
  await expect(last).not.toBeInViewport();

  await page.locator('.task-scroll').hover();
  await page.mouse.wheel(0, 400);
  await expect(last).toBeInViewport();
  await expect(page.getByRole('menuitem', { name: /Manage commands/ })).toBeInViewport();
});
