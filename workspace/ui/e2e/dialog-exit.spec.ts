import { expect, fadedOut, recordFade, test } from './fixtures';

test('a confirm dialog fades out (its node outlives the click) and stays inert until it is gone: a real '
  + 'click on OK during the fade must not reach it', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const before = await mock.state();
  const header = page.locator('details[data-sec="unstaged"] summary');
  await header.locator('[data-all="menu"]').click();
  await page.locator('.queue-menu [data-all="discard"]').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const read = await recordFade(page, '.dialog.alert');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // a real click during the fade must not reach OK: unlike a `.click()` call, inert keeps the browser from
  // ever delivering it, so Playwright's own actionability check on it times out
  await expect(dialog.getByRole('button', { name: 'OK' }).click({ timeout: 300 })).rejects.toThrow();
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
  expect(fadedOut(await read())).toBe(true);
  await mock.idle();
  expect(await mock.state()).toEqual(before);
});

test('Settings fades out (its node outlives Escape), is gone within 1s, and focus returns to what had it '
  + 'before the brand menu opened (not the menu item that closed it)', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('.brand').click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await mock.idle();
  const dialog = page.locator('.dialog.settings');
  await expect(dialog).toBeVisible();
  // long enough that the brand menu's own (unrelated) exit and its own restore-to-trigger are well done, so
  // only Settings' own restore can be responsible for where focus lands once it closes
  await page.waitForTimeout(300);
  const read = await recordFade(page, '.dialog.settings');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
  expect(fadedOut(await read())).toBe(true);
  await expect(list).toBeFocused();
});

test('a registered overlay (AI Tools) fades out (its node outlives Escape), is gone within 1s, and focus '
  + 'returns to what had it before the brand menu opened', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  await page.locator('.brand').click();
  await page.getByRole('menuitem', { name: 'Explore AI Tools…' }).click();
  await mock.idle();
  const dialog = page.locator('.dialog.ai-tools');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  const read = await recordFade(page, '.dialog.ai-tools');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
  expect(fadedOut(await read())).toBe(true);
  await expect(list).toBeFocused();
});

test('a command works again the instant a dialog closes, without waiting for its exit to finish',
  async ({ page, open }) => {
    const mock = await open('review', { motion: 'on' });
    await page.locator('.brand').click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await mock.idle();
    const dialog = page.locator('.dialog.settings');
    await expect(dialog).toBeVisible();
    const read = await recordFade(page, '.dialog.settings');
    await page.keyboard.press('Escape');
    // the palette opens right away, while Settings is still fading out behind it
    await page.keyboard.press('ControlOrMeta+Shift+P');
    await expect(page.locator('.dialog.pal')).toBeVisible();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
    expect(fadedOut(await read())).toBe(true);
  });

test('an alertdialog opened from the Changes section menu restores focus to what had it before the menu '
  + 'opened, a real, connected element (not the Cancel button the menu item wired up, or body)', async ({
  page, open,
}) => {
  const mock = await open('review', { motion: 'on' });
  const list = page.locator('.side .list');
  await list.focus();
  const header = page.locator('details[data-sec="unstaged"] summary');
  await header.locator('[data-all="menu"]').click();
  await page.locator('.queue-menu [data-all="discard"]').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const read = await recordFade(page, '.dialog.alert');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
  expect(fadedOut(await read())).toBe(true);
  await expect(list).toBeFocused();
  await mock.idle();
});

test('an action after a dialog closes that moves focus keeps it there, past the dialog\'s own restore',
  async ({ page, open }) => {
    const mock = await open('review', { motion: 'on' });
    const header = page.locator('details[data-sec="unstaged"] summary');
    await header.locator('[data-all="menu"]').click();
    await page.locator('.queue-menu [data-all="discard"]').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const read = await recordFade(page, '.dialog.alert');
    // one tick apart, with no round trip to Playwright in between: this stands in for a command that
    // resolves the dialog and then focuses the commit box, a race the dialog's own restore (an effect,
    // scheduled after this) must lose
    await page.evaluate(async () => {
      (document.querySelector('.dialog.alert .btn.primary') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
      document.getElementById('commit-message')?.focus();
    });
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
    expect(fadedOut(await read())).toBe(true);
    // the dialog's own restore, since focus already moved on by the time it runs, must leave this alone
    await expect(page.locator('#commit-message')).toBeFocused();
    await mock.idle();
  });

test('a dialog asked for while the last one is still fading out mounts on its own and takes focus',
  async ({ page, open }) => {
    const mock = await open('review', { motion: 'on' });
    const before = await mock.state();
    const header = page.locator('details[data-sec="unstaged"] summary');
    await header.locator('[data-all="menu"]').click();
    await page.locator('.queue-menu [data-all="discard"]').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    // past the entry animation, as a real answer is
    await page.waitForTimeout(300);
    // a command that asks again right after an answer (an error dialog for a git call that failed fast, say): the
    // second request lands once the first dialog's inert has taken focus off it, and before its exit is over.
    // Focus is read in the page: a retrying toBeFocused also passed on a revived dialog that got focus only later.
    const { overlapped, focused } = await page.evaluate(async () => {
      const url = '/src/kernel/dialogs.ts';
      const dialogs = await (import(url) as Promise<typeof import('../src/kernel/dialogs')>);
      const first = document.querySelector('.dialog.alert')!;
      (first.querySelector('.btn:not(.primary)') as HTMLButtonElement).click();
      for (let i = 0; i < 30 && document.activeElement !== document.body; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      const overlapped = first.isConnected;
      void dialogs.confirmDialog('Second question?');
      const inSecond = () => document.activeElement?.closest('[role="alertdialog"]')?.textContent
        .includes('Second question?');
      for (let i = 0; i < 25 && !inSecond(); i++) await new Promise((r) => setTimeout(r, 20));
      const focused = inSecond() ? document.activeElement?.textContent : document.activeElement?.tagName;
      return { overlapped, focused };
    });
    expect(overlapped).toBe(true);
    expect(focused).toBe('Cancel');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await mock.idle();
    expect(await mock.state()).toEqual(before);
  });
