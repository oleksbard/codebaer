import { expect, FULL_MOTION, row, test } from './fixtures';

const selKeys = (page: import('@playwright/test').Page) => page.evaluate(() =>
  [...document.querySelectorAll('.side .list .row.sel')].map((e) => (e as HTMLElement).dataset.key));

test('Enter right after staging the selected file opens the row it moved to, not the stale one', async (
  { page, open },
) => {
  const mock = await open('review', FULL_MOTION);
  await page.locator('.side .list').focus();
  await page.keyboard.press('ControlOrMeta+Shift+Y'); // stages the open file, src/cart.ts, which moves on
  await page.keyboard.press('Enter');
  await mock.idle();
  await row(page, 'unstaged', 'src/cart.ts').waitFor({ state: 'detached', timeout: 1000 });
  // the ghost's own onClick, still wired to the file it closed over, would reopen src/cart.ts here instead
  await expect(page.locator('main')).not.toContainText('src/cart.ts');
  await expect(row(page, 'unstaged', 'src/checkout.ts')).toHaveClass(/\bsel\b/);
});

test('ArrowDown right after staging the selected file moves on from the row it moved to, not the stale one',
  async ({ page, open }) => {
    const mock = await open('review', FULL_MOTION);
    await page.locator('.side .list').focus();
    await page.keyboard.press('ControlOrMeta+Shift+Y');
    await page.locator('.side .list').focus();
    await page.keyboard.press('ArrowDown');
    await mock.idle();
    await row(page, 'unstaged', 'src/cart.ts').waitFor({ state: 'detached', timeout: 1000 });
    // acceptFile already moved the selection on to checkout.ts; ArrowDown must move on again, from there
    expect(await selKeys(page)).toEqual(['unstaged:src/money.ts']);
  });

test('ArrowDown while the Staged section fades out does not select a row inside it', async ({ page, open }) => {
  const mock = await open('review', FULL_MOTION);
  // src/checkout.ts is the only staged file (also unstaged), so unstaging it drops q.staged to 0 and
  // Reveal starts fading the whole Staged section out
  await row(page, 'unstaged', 'tools/release.cmd').click();
  await mock.idle();
  await page.locator('.side .list').focus();
  await page.locator('details[data-sec="staged"] summary [data-all="menu"]').click();
  // fires a real ArrowDown keydown on the list, from inside the page, at the first frame the section is
  // already visibly fading: a fixed sleep could either miss the window or land after it, on a slow run
  const duringFade = page.evaluate(() => new Promise<void>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const wrap = document.querySelector('details[data-sec="staged"]')?.parentElement;
      const opacity = wrap ? Number(getComputedStyle(wrap).opacity) : 1;
      if (opacity < 0.9 || performance.now() - t0 > 1000) {
        document.querySelector('.side .list')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await page.locator('.queue-menu [data-all="unstage"]').click();
  await duringFade;
  await mock.idle();
  await expect(row(page, 'staged', 'src/checkout.ts')).toHaveCount(0);
  // a stale ArrowDown would have opened the just-unstaged checkout.ts and shown "nothing staged" there
  await expect(page.locator('main')).toContainText('tools/release.cmd');
  await expect(page.locator('main')).not.toContainText('nothing staged');
});
