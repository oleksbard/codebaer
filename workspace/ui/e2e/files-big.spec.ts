import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const PKG = 'apps/apps-3';
const AREAS = ['components', 'hooks', 'services', 'utils', 'models', 'pages', 'api', 'store'];

/** A row out of view is not in the DOM, so this pages down the tree from where it is, then once more from the
 *  top, until the folder's row is drawn. Each page waits for the list to draw the rows at its new offset,
 *  OVERSCAN (10) rows above it. */
async function openDir(page: Page, dir: string): Promise<void> {
  const row = page.locator(`.side [data-dir="${dir}"]`);
  const list = page.locator('.side .list');
  const drawnAt = () => list.evaluate((el) => {
    const want = Math.max(0, Math.floor(el.scrollTop / 26) - 10) * 26;
    return el.querySelector<HTMLElement>('.vlist-body')!.style.paddingTop === `${want}px`;
  });
  let fromTop = false;
  while (!(await row.count())) {
    const moved = await list.evaluate((el) => {
      const was = el.scrollTop;
      el.scrollTop += el.clientHeight;
      return el.scrollTop !== was;
    });
    if (!moved) {
      expect(fromTop, `${dir} is not in the tree`).toBe(false);
      fromTop = true;
      await list.evaluate((el) => { el.scrollTop = 0; });
    }
    await expect.poll(drawnAt).toBe(true);
  }
  await row.click();
}

test('a tree with about a thousand rows open draws only the rows in view, and scrolls to the last', async ({
  page, open,
}) => {
  const mock = await open('big');
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  for (const dir of ['apps', PKG, `${PKG}/src`, ...AREAS.map((a) => `${PKG}/src/${a}`), `${PKG}/node_modules`,
    'apps/apps-4', 'apps/apps-4/node_modules']) await openDir(page, dir);
  await mock.idle();
  // about 950 rows are open: 96 folders under src and 400 read from each node_modules
  const list = page.locator('.side .list');
  expect(await list.evaluate((el) => el.scrollHeight)).toBeGreaterThan(900 * 26);
  expect(await page.locator('.side .row, .side .sec').count()).toBeLessThan(120);

  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.side [data-dir="packages"]')).toBeVisible();
  expect(await page.locator('.side .row, .side .sec').count()).toBeLessThan(120);

  await page.locator('.side [data-dir="packages"]').click();
  await expect(page.locator('.side [data-dir="packages/packages-0"]')).toBeVisible();
});

test('Go to File in a repository of 48,000 files lists the first matches and narrows as you type', async ({
  page, open,
}) => {
  const mock = await open('big');
  await page.keyboard.press('ControlOrMeta+P');
  await expect(page.locator('.pal li:not(.desc)')).toHaveCount(200);
  await expect(page.locator('.pal li.more')).toHaveText(/^4[\d,]+ more\. Type to narrow the list\.$/);
  await page.keyboard.type('apps-3/src/hooks/hooks-5/file-7');
  // a fuzzy match: apps-13 and apps-23 hold the same letters in order
  await expect(page.locator('.pal li')).toHaveCount(3);
  await page.locator('.pal li', { hasText: 'apps/apps-3/src/hooks/hooks-5/file-7.ts' }).click();
  await mock.idle();
  await expect(page.locator('.tbar .file')).toHaveText(/file-7\.ts/);
});
