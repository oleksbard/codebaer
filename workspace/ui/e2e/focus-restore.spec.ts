import { expect, test } from './fixtures';

/** Every dialog or alert dialog here is opened from a menu item, a context menu item or the palette, never
 *  from a `Trigger` of its own: `ui/focus.ts`'s `lastFocusOutside` must be what puts focus back once it closes,
 *  not `document.activeElement` at mount (which by then is the menu item, gone once the menu unmounts). */

test('Changes section menu > Discard all changes restores focus to the queue list', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('details[data-sec="unstaged"] summary [data-all="menu"]').click();
  await page.getByRole('menuitem', { name: 'Discard all changes' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 1000 });
  await expect(list).toBeFocused();
  await mock.idle();
});

test('a row\'s context menu > Discard changes restores focus to the queue list', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('.side .list .row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Discard changes' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 1000 });
  await expect(list).toBeFocused();
  await mock.idle();
});

test('the repo switcher > Repository Preferences restores focus to the queue list', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('.repo-trigger').click();
  await page.getByRole('menuitem', { name: /Repository Preferences/ }).click();
  await mock.idle();
  const dialog = page.locator('.dialog.repo-prefs');
  await expect(dialog).toBeVisible();
  // long enough that the repo switcher's own (unrelated) exit and its own restore-to-trigger are well done,
  // so only this dialog's own restore can be responsible for where focus lands once it closes
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 1000 });
  await expect(list).toBeFocused();
});

test('the task menu > Manage commands restores focus to the queue list', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('.task-b').click();
  await page.locator('.menu-foot').click();
  await mock.idle();
  const dialog = page.locator('.dialog.settings');
  await expect(dialog).toBeVisible();
  // long enough that the task menu's own (unrelated) exit and its own restore-to-trigger are well done, so
  // only Settings' own restore can be responsible for where focus lands once it closes
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 1000 });
  await expect(list).toBeFocused();
});

test('the palette > Settings restores focus to the editor', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('Settings');
  await page.keyboard.press('Enter');
  await mock.idle();
  const dialog = page.locator('.dialog.settings');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 1000 });
  await expect(editor).toBeFocused();
});
