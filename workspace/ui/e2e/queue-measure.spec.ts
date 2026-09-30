import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

type Counts = { row: number; commit: number; sec: number };

async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __m: Counts };
    w.__m = { row: 0, commit: 0, sec: 0 };
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.closest('.side .list')) {
        if (this.classList.contains('commit-row')) w.__m.commit++;
        else if (this.classList.contains('row')) w.__m.row++;
        else if (this.tagName === 'DETAILS') w.__m.sec++;
      }
      return orig.call(this);
    };
  });
}

const read = (page: Page): Promise<Counts> => page.evaluate(() => (window as unknown as { __m: Counts }).__m);

test('typing in the editor does not re-measure the queue: layoutDependency stops the commit row, the '
  + 'section and the rest of the rows from being dirtied by every notify()', async ({ page, open }) => {
  await open('review', { motion: 'on' });
  await install(page);
  await page.locator('.cm-content').first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => { (window as unknown as { __m: Counts }).__m = { row: 0, commit: 0, sec: 0 }; });
  for (const ch of 'abcdefghij') { await page.keyboard.type(ch); await page.waitForTimeout(30); }
  await page.waitForTimeout(300);
  const n = await read(page);
  // an unbounded (buggy) CommitRow with no layoutDependency alone measures the outgoing commit row (and,
  // through the shared LayoutGroup, every row and section) on each of the 10 keystrokes; a fixed
  // layoutDependency limits it to what a hover or hover-free notify() touches regardless of key count
  expect(n.commit, `commit-row measurements: ${JSON.stringify(n)}`).toBeLessThan(10);
  expect(n.row, `row measurements: ${JSON.stringify(n)}`).toBeLessThan(30);
  expect(n.sec, `section measurements: ${JSON.stringify(n)}`).toBeLessThan(15);
});
